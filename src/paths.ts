import type { ContextStorageKeys } from "./types.js";

export const defaultLayout = [
  "workspace",
  "memory",
  "artifacts",
  "logs",
  "cache",
  "config",
] as const;

/**
 * Storage keys embed the raw context id, so the id must never be able to
 * introduce path separators or traversal into a key (or a filesystem path
 * for directory-backed storage adapters).
 */
export function assertValidContextId(id: string): void {
  if (!/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new Error(
      `invalid context id: ${JSON.stringify(id)} — ids must start with a letter or digit and use only letters, digits, ".", "_", "-" (max 200 chars)`,
    );
  }
}

export function contextKeys(id: string): ContextStorageKeys {
  assertValidContextId(id);
  return {
    image: `contexts/${id}/current.img.enc`,
    tree: `contexts/${id}/current.tree.tar.zst.enc`,
    manifest: `contexts/${id}/manifest.json`,
    lock: `contexts/${id}/lock.json`,
    checkpoints: `contexts/${id}/checkpoints`,
  };
}

/**
 * Bundle and image objects are written under generation-scoped, per-attempt keys and
 * the manifest write is the atomic commit that flips to them. Writing in place at a
 * fixed key would re-encrypt with a fresh nonce/tag under the old manifest's metadata,
 * so a crash between the two writes leaves a context that can never be decrypted again.
 * The attempt suffix keeps two racing writers of the same generation on distinct objects.
 */
export function generationDataKeys(id: string, generation: number, attempt: string): { tree: string; image: string } {
  const suffix = `${String(generation).padStart(8, "0")}-${attempt}`;
  return {
    tree: `contexts/${id}/tree/${suffix}.tree.tar.zst.enc`,
    image: `contexts/${id}/image/${suffix}.img.enc`,
  };
}

/**
 * True for data objects that a newer save supersedes and may garbage-collect:
 * generation-scoped keys plus the legacy fixed "current.*" keys. Checkpoint
 * objects live under checkpoints/ and are intentionally not replaceable.
 */
export function isReplaceableDataKey(id: string, key: string): boolean {
  return key.startsWith(`contexts/${id}/tree/`)
    || key.startsWith(`contexts/${id}/image/`)
    || key === `contexts/${id}/current.tree.tar.zst.enc`
    || key === `contexts/${id}/current.img.enc`;
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
