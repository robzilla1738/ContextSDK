import { Readable } from "node:stream";
import { ContextSDKError } from "./errors.js";

export interface PutObjectOptions {
  ifNoneMatch?: string;
}

export interface ObjectMetadata {
  size?: number;
  updatedAt?: Date;
}

export interface StorageAdapter {
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer | Uint8Array | string, options?: PutObjectOptions): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<ObjectMetadata | null>;
}

export class MemoryStorage implements StorageAdapter {
  private readonly objects = new Map<string, { body: Buffer; updatedAt: Date }>();

  async getObject(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) {
      throw new ContextSDKError(`object not found: ${key}`);
    }
    return Buffer.from(object.body);
  }

  async putObject(key: string, body: Buffer | Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    if (options.ifNoneMatch === "*" && this.objects.has(key)) {
      throw new ContextSDKError(`object already exists: ${key}`);
    }
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body),
      updatedAt: new Date(),
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
    return { size: object.body.byteLength, updatedAt: object.updatedAt };
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
    for await (const chunk of input as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new ContextSDKError("unsupported object body type");
}
