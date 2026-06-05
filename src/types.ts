import type { StorageAdapter } from "./storage.js";
import type { RuntimeAdapter } from "./runtime.js";

export type ContextId = string;
export type ContextFormat = "tree" | "ext4";
export type RuntimeProvider = "e2b" | "vercel" | "modal" | "ssh" | "unknown";

export interface EncryptionConfig {
  passphrase?: string;
  rawKeyHex?: string;
}

export interface EncryptionMetadata {
  version: 1;
  algorithm: "aes-256-gcm";
  keyDerivation: "scrypt" | "raw";
  salt?: string;
  nonce: string;
  authTag: string;
}

export interface ContextManifest {
  version: 1;
  id: ContextId;
  format: ContextFormat;
  filesystem: "ext4" | "tree";
  sizeBytes: number;
  generation: number;
  checkpointGeneration?: number;
  imageKey: string;
  treeKey: string;
  latestCheckpoint?: ContextCheckpointRecord;
  encryption: EncryptionMetadata;
  treeEncryption?: EncryptionMetadata;
  imageEncryption?: EncryptionMetadata;
  layout: string[];
  latestVersion?: ContextVersionRecord;
  versions?: ContextVersionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ContextLock {
  version: 1;
  contextId: ContextId;
  owner: string;
  runtimeId: string;
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface ContextStorageKeys {
  image: string;
  tree: string;
  manifest: string;
  lock: string;
  checkpoints: string;
}

export interface CreateContextOptions {
  id: ContextId;
  size?: string | number;
  storage: StorageAdapter;
  encryption: EncryptionConfig;
  format?: ContextFormat;
  force?: boolean;
}

export interface AttachContextOptions {
  id: ContextId;
  storage: StorageAdapter;
  encryption: EncryptionConfig;
  runtime: RuntimeAdapter;
  mountPath?: string;
  owner?: string;
  lockTtlMs?: number;
  forceUnlock?: boolean;
}

export interface SaveContextOptions {
  id: ContextId;
  storage: StorageAdapter;
  encryption: EncryptionConfig;
  runtime: RuntimeAdapter;
  mountPath?: string;
  owner?: string;
  cleanupRemote?: boolean;
  author?: string;
  message?: string;
}

export interface DetachContextOptions {
  id: ContextId;
  storage: StorageAdapter;
  runtime: RuntimeAdapter;
  mountPath?: string;
  owner?: string;
  cleanupRemote?: boolean;
  forceUnlock?: boolean;
}

export interface MountedContext {
  id: ContextId;
  owner: string;
  runtimeId: string;
  mountPath: string;
  remoteImagePath: string;
  remoteBundlePath?: string;
  loopDevice?: string;
  localTempDir: string;
  mode?: "loopExt4" | "directoryBundle";
}

export interface ContextFileEntry {
  path: string;
  size: number;
  mode: string;
  mtime: string;
  sha256: string;
}

export interface ContextVersionChange {
  path: string;
  type: "added" | "modified" | "removed";
}

export interface ContextVersionRecord {
  version: 1;
  generation: number;
  parentGeneration: number | null;
  timestamp: string;
  author: string;
  message: string;
  changedPaths: ContextVersionChange[];
  files: ContextFileEntry[];
}

export interface ContextCheckpointRecord {
  version: 1;
  generation: number;
  reason: string;
  timestamp: string;
  treeKey: string;
  sizeBytes: number;
}

export interface ContextSession {
  id: ContextId;
  owner: string;
  runtimeId: string;
  mountPath: string;
  runtime: RuntimeAdapter;
  mounted: MountedContext;
  files: ContextFileManager;
  memory: {
    append(note: string): Promise<void>;
  };
  artifacts: {
    write(path: string, data: string | Buffer | Uint8Array): Promise<void>;
  };
  logs: {
    append(line: string): Promise<void>;
  };
}

export interface ContextFileManager {
  write(path: string, data: string | Buffer | Uint8Array): Promise<void>;
  append(path: string, line: string): Promise<void>;
  read(path: string): Promise<Buffer>;
  list(path?: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  resolve(path: string): string;
}

export interface RuntimeProvisioner {
  createSessionRuntime(options?: Record<string, unknown>): Promise<RuntimeAdapter>;
  destroyRuntime?(runtime: RuntimeAdapter): Promise<void>;
}

export interface RuntimeCapabilities {
  loopExt4?: boolean;
  directoryBundle?: boolean;
  providerVolume?: boolean;
  providerSnapshot?: boolean;
}

export interface RuntimeProbeResult {
  provider: RuntimeProvider | string;
  runtimeId: string;
  capabilities: RuntimeCapabilities;
  missingTools: string[];
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface StartContextSessionOptions extends Omit<AttachContextOptions, "runtime"> {
  runtime: RuntimeAdapter;
  createIfMissing?: boolean;
  size?: string | number;
}

export interface RunWithContextOptions extends Omit<StartContextSessionOptions, "runtime"> {
  runtime?: RuntimeAdapter;
  saveOnError?: boolean;
  author?: string;
  message?: string;
  provisioner?: RuntimeProvisioner;
  checkpoint?: {
    intervalMs?: number;
    enabled?: boolean;
  };
}

export interface CheckpointContextOptions {
  reason?: string;
}
