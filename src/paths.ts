import type { ContextStorageKeys } from "./types.js";

export const defaultLayout = [
  "workspace",
  "memory",
  "artifacts",
  "logs",
  "cache",
  "config",
] as const;

export function contextKeys(id: string): ContextStorageKeys {
  return {
    image: `contexts/${id}/current.img.enc`,
    tree: `contexts/${id}/current.tree.tar.zst.enc`,
    manifest: `contexts/${id}/manifest.json`,
    lock: `contexts/${id}/lock.json`,
    checkpoints: `contexts/${id}/checkpoints`,
  };
}

export function remoteImagePath(id: string): string {
  return `/tmp/contextsdk-${sanitizeId(id)}.ext4.img`;
}

export function remoteBundlePath(id: string): string {
  return `/tmp/contextsdk-${sanitizeId(id)}.tree.tar.zst`;
}

export function defaultMountPath(id: string): string {
  return `/mnt/contextsdk/${sanitizeId(id)}`;
}

export function sanitizeId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_.-]/g, "-");
  if (!sanitized) {
    throw new Error("context id must contain at least one portable character");
  }
  return sanitized;
}
