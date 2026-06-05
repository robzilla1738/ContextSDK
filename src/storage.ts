import { constants as bufferConstants } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ContextSDKError, ObjectNotFoundError, StorageConditionError } from "./errors.js";

export interface PutObjectOptions {
  /** Fail with StorageConditionError when the object already exists. Use "*" to match any existing object. */
  ifNoneMatch?: string;
  /** Fail with StorageConditionError unless the stored object's etag matches. Enables compare-and-swap updates. */
  ifMatch?: string;
}

export interface ObjectMetadata {
  size?: number;
  updatedAt?: Date;
  etag?: string;
}

export interface StorageAdapter {
  getObject(key: string): Promise<Buffer>;
  /**
   * Atomically read body and etag of one object revision. Locking depends on it:
   * expired-lock takeover refuses to proceed without an etag to compare-and-swap on.
   */
  getObjectWithMetadata(key: string): Promise<{ body: Buffer; metadata: ObjectMetadata }>;
  putObject(key: string, body: Buffer | Uint8Array | string, options?: PutObjectOptions): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<ObjectMetadata | null>;
  /**
   * Lists keys under a prefix. Optional: adapters that cannot enumerate (or choose
   * not to) may omit it, in which case prefix-wide cleanup degrades to best-effort.
   */
  listObjects?(prefix: string): Promise<string[]>;
}

export class MemoryStorage implements StorageAdapter {
  private readonly objects = new Map<string, { body: Buffer; updatedAt: Date; etag: string }>();

  async getObject(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) {
      throw new ObjectNotFoundError(key);
    }
    return Buffer.from(object.body);
  }

  async getObjectWithMetadata(key: string): Promise<{ body: Buffer; metadata: ObjectMetadata }> {
    const object = this.objects.get(key);
    if (!object) {
      throw new ObjectNotFoundError(key);
    }
    return {
      body: Buffer.from(object.body),
      metadata: { size: object.body.byteLength, updatedAt: object.updatedAt, etag: object.etag },
    };
  }

  async putObject(key: string, body: Buffer | Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    const existing = this.objects.get(key);
    if (options.ifNoneMatch === "*" && existing) {
      throw new StorageConditionError(`object already exists: ${key}`);
    }
    if (options.ifMatch !== undefined && (!existing || existing.etag !== options.ifMatch)) {
      throw new StorageConditionError(`precondition failed for object: ${key}`);
    }
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body),
      updatedAt: new Date(),
      etag: randomUUID(),
    });
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return { size: object.body.byteLength, updatedAt: object.updatedAt, etag: object.etag };
  }

  async listObjects(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(key => key.startsWith(prefix));
  }
}

export async function readableToBuffer(input: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (typeof input === "string") {
    return Buffer.from(input);
  }
  if (input instanceof Readable || (input && typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function")) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of input as AsyncIterable<Buffer | Uint8Array | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      // Storage bodies are materialized as a single Buffer; past the platform limit V8
      // throws an opaque RangeError. Fail with an actionable message instead.
      if (total > bufferConstants.MAX_LENGTH) {
        throw new ContextSDKError(
          `object exceeds the maximum supported in-memory size of ${bufferConstants.MAX_LENGTH} bytes; `
          + "split the context or exclude large runtime artifacts from the portable bundle",
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  throw new ContextSDKError("unsupported object body type");
}
