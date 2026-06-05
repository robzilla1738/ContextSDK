import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ContextLockError, ObjectNotFoundError, StorageConditionError } from "./errors.js";
import { contextKeys } from "./paths.js";
import type { ContextLock } from "./types.js";
import type { PutObjectOptions, StorageAdapter } from "./storage.js";

export const defaultLockTtlMs = 30 * 60 * 1000;

export function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

export async function acquireLock(options: {
  storage: StorageAdapter;
  contextId: string;
  runtimeId: string;
  owner: string;
  ttlMs: number;
  force?: boolean;
}): Promise<ContextLock> {
  const key = contextKeys(options.contextId).lock;
  const now = new Date();
  const existing = await readLockWithMetadata(options.storage, options.contextId);
  if (existing && !isExpired(existing.lock, now) && !options.force) {
    throw new ContextLockError(`context ${options.contextId} is locked by ${existing.lock.owner} until ${existing.lock.expiresAt}`);
  }
  const lock: ContextLock = {
    version: 1,
    contextId: options.contextId,
    owner: options.owner,
    runtimeId: options.runtimeId,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + options.ttlMs).toISOString(),
  };
  // Compare-and-swap semantics: a fresh acquire must create the object atomically,
  // and an expired-lock takeover must replace exactly the lock revision we observed.
  // Without this, two writers that both observe an expired lock would both "win".
  let conditions: PutObjectOptions | undefined;
  if (options.force) {
    conditions = undefined;
  } else if (existing) {
    if (!existing.etag) {
      // Fail safe: without an etag there is no atomic takeover, and a blind
      // overwrite would let two writers both believe they hold the lock.
      throw new ContextLockError(
        `context ${options.contextId} has an expired lock, but the storage adapter did not return an etag for atomic takeover; release the lock or retry with force`,
      );
    }
    conditions = { ifMatch: existing.etag };
  } else {
    conditions = { ifNoneMatch: "*" };
  }
  try {
    await options.storage.putObject(key, JSON.stringify(lock, null, 2), conditions);
  } catch (error) {
    if (error instanceof StorageConditionError) {
      throw new ContextLockError(`context ${options.contextId} lock was acquired by another writer`);
    }
    throw error;
  }
  return lock;
}

export async function renewLock(options: {
  storage: StorageAdapter;
  contextId: string;
  owner: string;
  ttlMs: number;
}): Promise<ContextLock> {
  const key = contextKeys(options.contextId).lock;
  const existing = await readLockWithMetadata(options.storage, options.contextId);
  if (!existing) {
    throw new ContextLockError(`context ${options.contextId} lock no longer exists; cannot renew`);
  }
  if (existing.lock.owner !== options.owner) {
    throw new ContextLockError(`context ${options.contextId} lock is now held by ${existing.lock.owner}`);
  }
  const now = new Date();
  const renewed: ContextLock = {
    ...existing.lock,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + options.ttlMs).toISOString(),
  };
  try {
    // Renewal without an etag degrades to an owner-checked overwrite; unlike
    // takeover this only ever extends a lock we already verified we hold.
    await options.storage.putObject(
      key,
      JSON.stringify(renewed, null, 2),
      existing.etag ? { ifMatch: existing.etag } : undefined,
    );
  } catch (error) {
    if (error instanceof StorageConditionError) {
      throw new ContextLockError(`context ${options.contextId} lock changed during renewal`);
    }
    throw error;
  }
  return renewed;
}

/**
 * Throws when the context lock is held by a different owner. An absent lock is
 * deliberately allowed: it means the lock was released or expired and deleted,
 * and refusing to write would strand legitimate recovery saves. The dangerous
 * case — another writer actively holding the lock — is the one this guards.
 */
export async function assertLockOwnership(options: {
  storage: Pick<StorageAdapter, "getObject">;
  contextId: string;
  owner: string;
}): Promise<void> {
  const lock = await readLock(options.storage, options.contextId);
  if (lock && lock.owner !== options.owner) {
    throw new ContextLockError(`context ${options.contextId} is now locked by ${lock.owner}; refusing to write`);
  }
}

export async function readLock(storage: Pick<StorageAdapter, "getObject">, contextId: string): Promise<ContextLock | null> {
  const result = await readLockWithMetadata(storage, contextId);
  return result?.lock ?? null;
}

async function readLockWithMetadata(
  storage: Pick<StorageAdapter, "getObject"> & Partial<Pick<StorageAdapter, "getObjectWithMetadata">>,
  contextId: string,
): Promise<{ lock: ContextLock; etag?: string } | null> {
  const key = contextKeys(contextId).lock;
  let body: Buffer;
  let etag: string | undefined;
  try {
    if (storage.getObjectWithMetadata) {
      const result = await storage.getObjectWithMetadata(key);
      body = result.body;
      etag = result.metadata.etag;
    } else {
      body = await storage.getObject(key);
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError || /object not found/.test(error instanceof Error ? error.message : "")) {
      return null;
    }
    throw error;
  }
  let lock: ContextLock;
  try {
    lock = JSON.parse(body.toString("utf8")) as ContextLock;
  } catch {
    throw new ContextLockError(`context ${contextId} lock data is corrupt; release it with force to recover`);
  }
  return { lock, etag };
}

export async function releaseLock(options: {
  storage: StorageAdapter;
  contextId: string;
  owner?: string;
  force?: boolean;
}): Promise<void> {
  const existing = await readLock(options.storage, options.contextId);
  if (!existing) {
    return;
  }
  if (!options.force && (!options.owner || existing.owner !== options.owner)) {
    throw new ContextLockError(`cannot release lock owned by ${existing.owner}`);
  }
  // Note: deleteObject is unconditional, so a writer that takes over between this
  // ownership check and the delete can have its lock removed. Backends without
  // conditional deletes cannot close this window; renewal plus assertLockOwnership
  // on save keeps the one-active-writer invariant for context data writes.
  await options.storage.deleteObject(contextKeys(options.contextId).lock);
}

export function isExpired(lock: ContextLock, now = new Date()): boolean {
  return Date.parse(lock.expiresAt) <= now.getTime();
}
