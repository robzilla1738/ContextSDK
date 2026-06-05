import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ContextLockError } from "./errors.js";
import { contextKeys } from "./paths.js";
import type { ContextLock } from "./types.js";
import type { StorageAdapter } from "./storage.js";

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
  const existing = await readLock(options.storage, options.contextId);
  if (existing && !isExpired(existing, now) && !options.force) {
    throw new ContextLockError(`context ${options.contextId} is locked by ${existing.owner} until ${existing.expiresAt}`);
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
  await options.storage.putObject(key, JSON.stringify(lock, null, 2), existing || options.force ? undefined : { ifNoneMatch: "*" });
  return lock;
}

export async function readLock(storage: StorageAdapter, contextId: string): Promise<ContextLock | null> {
  const key = contextKeys(contextId).lock;
  if (!await storage.headObject(key)) {
    return null;
  }
  return JSON.parse((await storage.getObject(key)).toString("utf8")) as ContextLock;
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
  await options.storage.deleteObject(contextKeys(options.contextId).lock);
}

export function isExpired(lock: ContextLock, now = new Date()): boolean {
  return Date.parse(lock.expiresAt) <= now.getTime();
}
