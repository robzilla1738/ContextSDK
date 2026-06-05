import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ContextSDKError, ObjectNotFoundError, StorageConditionError } from "./errors.js";
import type { ObjectMetadata, PutObjectOptions, StorageAdapter } from "./storage.js";

export interface FsStorageOptions {
  /** Directory that holds all objects. Created on first write. */
  directory: string;
}

/**
 * Durable local-filesystem storage for single-machine use: development, personal
 * agents, and CI. ETags are content hashes; conditional writes are serialized by
 * a per-key lock directory (mkdir is atomic on POSIX), so the same CAS-based lock
 * protocol used against S3 holds between processes on one machine. For anything
 * multi-machine, use S3-compatible storage.
 */
export class FsStorage implements StorageAdapter {
  private readonly root: string;

  constructor(options: FsStorageOptions) {
    this.root = resolve(options.directory);
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      throw this.mapMissing(error, key);
    }
  }

  async getObjectWithMetadata(key: string): Promise<{ body: Buffer; metadata: ObjectMetadata }> {
    try {
      const path = this.pathFor(key);
      const body = await readFile(path);
      const info = await stat(path);
      return { body, metadata: { size: body.byteLength, updatedAt: info.mtime, etag: await this.etagFor(path, body) } };
    } catch (error) {
      throw this.mapMissing(error, key);
    }
  }

  async putObject(key: string, body: Buffer | Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    const path = this.pathFor(key);
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array | string);
    await mkdir(dirname(path), { recursive: true });
    await this.withKeyLock(path, async () => {
      const existing = await readFile(path).catch(() => null);
      if (options.ifNoneMatch === "*" && existing) {
        throw new StorageConditionError(`object already exists: ${key}`);
      }
      if (options.ifMatch !== undefined && (!existing || await this.etagFor(path, existing) !== options.ifMatch)) {
        throw new StorageConditionError(`precondition failed for object: ${key}`);
      }
      // A fresh write token makes every write produce a distinct ETag even when
      // the bytes are identical, so a stale ifMatch cannot succeed across an
      // A→B→A sequence (the content-hash-only ABA hole).
      const token = randomUUID();
      const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temp, data, { mode: 0o600 });
      await writeFile(etagSidecar(path), token, { mode: 0o600 });
      await rename(temp, path);
    });
  }

  async deleteObject(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(etagSidecar(path), { force: true });
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const path = this.pathFor(key);
      const info = await stat(path);
      const body = await readFile(path);
      return { size: info.size, updatedAt: info.mtime, etag: await this.etagFor(path, body) };
    } catch {
      return null;
    }
  }

  async listObjects(prefix: string): Promise<string[]> {
    const base = this.pathFor(prefix);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.endsWith(".lock")) {
            continue;
          }
          await walk(full);
        } else if (entry.isFile() && !isInternalFile(entry.name)) {
          out.push(relative(this.root, full).split(sep).join("/"));
        }
      }
    };
    // base may be a file (exact-key prefix) or a directory tree.
    const info = await stat(base).catch(() => null);
    if (info?.isDirectory()) {
      await walk(base);
    } else if (info?.isFile()) {
      out.push(prefix);
    }
    return out;
  }

  /** Returns the per-write token if present, else falls back to a content hash. */
  private async etagFor(path: string, body: Buffer): Promise<string> {
    const token = await readFile(etagSidecar(path), "utf8").catch(() => null);
    return token ? token.trim() : createHash("sha256").update(body).digest("hex");
  }

  private pathFor(key: string): string {
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new ContextSDKError(`storage key escapes the storage directory: ${key}`);
    }
    return path;
  }

  private mapMissing(error: unknown, key: string): Error {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new ObjectNotFoundError(key);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Serializes conditional writes per key. mkdir is atomic, so exactly one
   * process holds the lock directory. A heartbeat file inside the lock dir is
   * refreshed while held; a lock is only broken when its heartbeat goes stale,
   * so a slow but live write is never stolen, and a crashed holder is reclaimed.
   */
  private async withKeyLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = `${path}.lock`;
    const heartbeatFile = join(lockDir, "heartbeat");
    const token = randomUUID();
    const staleMs = 10_000;
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await mkdir(lockDir);
        await writeFile(heartbeatFile, token);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const info = await stat(heartbeatFile).catch(() => null);
        // No heartbeat yet, or a stale one: the holder crashed before writing it
        // or stopped refreshing. Break the lock and retry the create.
        if (!info || Date.now() - info.mtimeMs > staleMs) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
        if (Date.now() > deadline) {
          throw new ContextSDKError(`timed out waiting for storage key lock: ${lockDir}`);
        }
        await delay(50);
      }
    }
    // Refresh the heartbeat well within staleMs so a long write is never judged dead.
    const heartbeat = setInterval(() => {
      void writeFile(heartbeatFile, token).catch(() => undefined);
    }, Math.floor(staleMs / 3));
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      // Only remove the lock if we still own it; a heartbeat we no longer own
      // means another holder reclaimed a lock we thought was ours.
      const owner = await readFile(heartbeatFile, "utf8").catch(() => null);
      if (owner === null || owner === token) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

function etagSidecar(path: string): string {
  return `${path}.etagid`;
}

function isInternalFile(name: string): boolean {
  return name.endsWith(".etagid") || name.includes(".tmp-");
}

/** Default location of the local object store used when no S3 bucket is configured. */
export function defaultFsStorageDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".contextsdk", "storage");
}
