import type { StorageAdapter } from "./storage.js";
import type { RuntimeAdapter } from "./runtime.js";

export type ContextId = string;
export type ContextFormat = "tree" | "ext4";
export type RuntimeProvider = "e2b" | "vercel" | "modal" | "ssh" | "unknown";

export interface ScryptParams {
  /** CPU/memory cost (N). Must be a power of two. */
  cost: number;
  /** Block size (r). */
  blockSize: number;
  /** Parallelization (p). */
  parallelization: number;
}

export interface EncryptionConfig {
  passphrase?: string;
  rawKeyHex?: string;
  /** Override scrypt parameters for new encryptions. Decryption always uses the parameters recorded in metadata. */
  scrypt?: Partial<ScryptParams>;
}

export interface EncryptionMetadata {
  version: 1;
  algorithm: "aes-256-gcm";
  keyDerivation: "scrypt" | "raw";
  salt?: string;
  nonce: string;
  authTag: string;
  /** scrypt parameters used for key derivation. Absent on legacy bundles, which used cost=16384, blockSize=8, parallelization=1. */
  scrypt?: ScryptParams;
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
  persistencePolicy?: ContextPersistencePolicy;
  runtimeState?: RuntimeStateMetadata;
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
  persistencePolicy?: Partial<ContextPersistencePolicy>;
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
  /** Timeout for remote pack/unpack/mount commands. Defaults to 15 minutes. */
  commandTimeoutMs?: number;
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
  persistencePolicy?: Partial<ContextPersistencePolicy>;
  runtimeState?: "auto" | "disabled";
  /** The mode attach mounted with. Session callers pass it so save never re-derives a different one. */
  mode?: MountedContext["mode"];
  /** Timeout for remote pack/save commands. Defaults to 15 minutes. */
  commandTimeoutMs?: number;
}

export interface DetachContextOptions {
  id: ContextId;
  storage: StorageAdapter;
  runtime: RuntimeAdapter;
  mountPath?: string;
  owner?: string;
  cleanupRemote?: boolean;
  forceUnlock?: boolean;
  /** The mode attach mounted with. Session callers pass it so detach never re-derives a different one. */
  mode?: MountedContext["mode"];
  /** Timeout for remote detach commands. Defaults to 15 minutes. */
  commandTimeoutMs?: number;
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

export interface ContextPersistencePolicy {
  roots: string[];
  exclude: string[];
}

export interface RuntimeStateMetadata {
  provider: RuntimeProvider | string;
  mode: "provider-persistence" | "provider-snapshot" | "provider-volume" | "disabled" | string;
  sandboxName?: string;
  persistent?: boolean;
  currentSnapshotId?: string;
  sourceSnapshotId?: string;
  updatedAt: string;
  details?: Record<string, unknown>;
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
  createSessionRuntime(options?: RuntimeProvisionOptions): Promise<RuntimeAdapter>;
  destroyRuntime?(runtime: RuntimeAdapter): Promise<void>;
}

export interface RuntimeProvisionOptions {
  contextId?: ContextId;
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
  persistencePolicy?: Partial<ContextPersistencePolicy>;
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
  persistencePolicy?: Partial<ContextPersistencePolicy>;
  runtimeState?: "auto" | "disabled";
}

export interface CheckpointContextOptions {
  reason?: string;
  persistencePolicy?: Partial<ContextPersistencePolicy>;
  /** Timeout for the remote pack command. Defaults to 15 minutes. */
  commandTimeoutMs?: number;
}
