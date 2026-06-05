import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptFile, decryptFile } from "./crypto.js";
import { ContextSDKError } from "./errors.js";
import { createArtifactsApi, createLogsApi, createMemoryApi, MountedContextFileManager } from "./file-manager.js";
import { createExt4Image, parseSize, validateExt4Image } from "./local-image.js";
import { acquireLock, makeOwner, readLock, releaseLock } from "./lock.js";
import { contextKeys, defaultLayout, defaultMountPath, remoteBundlePath, remoteImagePath } from "./paths.js";
import { resolvePersistencePolicy } from "./persistence-policy.js";
import { assertSuccess } from "./runtime.js";
import { detachDirectoryScript, detachScript, ensureRuntimeToolsScript, mountScript, packBundleScript, saveScript, unpackBundleScript } from "./scripts.js";
import { shellQuote } from "./shell.js";
import { packContextTree, prepareContextTree, unpackContextTree } from "./tree-bundle.js";
import { snapshotScript } from "./versioning.js";
import type { RuntimeAdapter } from "./runtime.js";
import type {
  AttachContextOptions,
  CheckpointContextOptions,
  ContextManifest,
  ContextSession,
  ContextVersionRecord,
  CreateContextOptions,
  DetachContextOptions,
  MountedContext,
  RuntimeStateMetadata,
  RunWithContextOptions,
  SaveContextOptions,
  StartContextSessionOptions,
} from "./types.js";

export async function createContext(options: CreateContextOptions): Promise<ContextManifest> {
  const keys = contextKeys(options.id);
  if (!options.force && await options.storage.headObject(keys.manifest)) {
    throw new ContextSDKError(`context already exists: ${options.id}`);
  }
  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-create-"));
  try {
    const format = options.format ?? "tree";
    const rawPath = join(tempDir, "context.ext4.img");
    const treeRoot = join(tempDir, "tree");
    const treePath = join(tempDir, "context.tree.tar.zst");
    const encryptedPath = join(tempDir, "context.ext4.img.enc");
    const encryptedTreePath = join(tempDir, "context.tree.tar.zst.enc");
    const sizeBytes = options.size ? await parseSize(options.size) : 0;
    const persistencePolicy = resolvePersistencePolicy(options.persistencePolicy);
    await prepareContextTree({ root: treeRoot, contextId: options.id });
    await packContextTree({ root: treeRoot, archivePath: treePath, policy: persistencePolicy });
    const treeEncryption = await encryptFile(treePath, encryptedTreePath, options.encryption);
    const imageEncryption = format === "ext4"
      ? await createAndEncryptExt4({ rawPath, encryptedPath, stagingDir: treeRoot, sizeBytes: sizeBytes || 256 * 1024 * 1024, contextId: options.id, encryption: options.encryption })
      : treeEncryption;
    const now = new Date().toISOString();
    const manifest: ContextManifest = {
      version: 1,
      id: options.id,
      format,
      filesystem: format === "ext4" ? "ext4" : "tree",
      sizeBytes: format === "ext4" ? sizeBytes || 256 * 1024 * 1024 : (await stat(treePath)).size,
      generation: 1,
      checkpointGeneration: 0,
      imageKey: keys.image,
      treeKey: keys.tree,
      encryption: format === "ext4" ? imageEncryption : treeEncryption,
      treeEncryption,
      imageEncryption: format === "ext4" ? imageEncryption : undefined,
      layout: [...defaultLayout],
      versions: [],
      persistencePolicy,
      createdAt: now,
      updatedAt: now,
    };
    await options.storage.putObject(keys.tree, await readFile(encryptedTreePath));
    if (format === "ext4") {
      await options.storage.putObject(keys.image, await readFile(encryptedPath));
    }
    await options.storage.putObject(keys.manifest, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function attachContext(options: AttachContextOptions): Promise<MountedContext> {
  const manifest = await readManifest(options.storage, options.id);
  const owner = options.owner ?? makeOwner();
  const mountPath = options.mountPath ?? options.runtime.defaultMountPath?.(options.id) ?? defaultMountPath(options.id);
  const remotePath = remoteImagePath(options.id);
  const remoteTreePath = remoteBundlePath(options.id);
  await acquireLock({
    storage: options.storage,
    contextId: options.id,
    runtimeId: options.runtime.id,
    owner,
    ttlMs: options.lockTtlMs ?? 30 * 60 * 1000,
    force: options.forceUnlock,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-attach-"));
  try {
    const encryptedPath = join(tempDir, "current.img.enc");
    const rawPath = join(tempDir, "current.img");
    const treeEncryptedPath = join(tempDir, "current.tree.tar.zst.enc");
    const treePath = join(tempDir, "current.tree.tar.zst");
    const treeRoot = join(tempDir, "tree");
    const useDirectoryBundle = Boolean(options.runtime.capabilities?.directoryBundle) && !options.runtime.capabilities?.loopExt4;
    if (useDirectoryBundle || manifest.format === "tree") {
      await writeFile(treeEncryptedPath, await options.storage.getObject(manifest.treeKey), { mode: 0o600 });
      await decryptFile(treeEncryptedPath, treePath, manifest.treeEncryption ?? manifest.encryption, options.encryption);
      if (useDirectoryBundle) {
        await options.runtime.uploadFile(treePath, remoteTreePath);
        const mountResult = await options.runtime.run(unpackBundleScript(remoteTreePath, mountPath, manifest.persistencePolicy), { user: "root" });
        assertSuccess(mountResult, "mount context bundle");
        return {
          id: options.id,
          owner,
          runtimeId: options.runtime.id,
          mountPath,
          remoteImagePath: remotePath,
          remoteBundlePath: remoteTreePath,
          localTempDir: tempDir,
          mode: "directoryBundle",
        };
      }
      await unpackContextTree({ archivePath: treePath, destination: treeRoot });
      const sizeBytes = manifest.sizeBytes && manifest.sizeBytes > 8 * 1024 * 1024 ? manifest.sizeBytes : 256 * 1024 * 1024;
      await createExt4Image({ imagePath: rawPath, stagingDir: treeRoot, sizeBytes, contextId: options.id, useExistingStagingDir: true });
    } else {
      await writeFile(encryptedPath, await options.storage.getObject(manifest.imageKey), { mode: 0o600 });
      await decryptFile(encryptedPath, rawPath, manifest.imageEncryption ?? manifest.encryption, options.encryption);
      await validateExt4Image(rawPath);
    }
    await options.runtime.uploadFile(rawPath, remotePath);
    assertSuccess(await options.runtime.run(ensureRuntimeToolsScript(), { user: "root" }), "runtime tool check");
    const mountResult = await options.runtime.run(mountScript(remotePath, mountPath), { user: "root" });
    assertSuccess(mountResult, "mount context");
    const mounted: MountedContext = {
      id: options.id,
      owner,
      runtimeId: options.runtime.id,
      mountPath,
      remoteImagePath: remotePath,
      remoteBundlePath: remoteTreePath,
      loopDevice: parseLoopDevice(mountResult.stdout),
      localTempDir: tempDir,
      mode: "loopExt4",
    };
    return mounted;
  } catch (error) {
    await releaseLock({ storage: options.storage, contextId: options.id, owner, force: true }).catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function saveContext(options: SaveContextOptions): Promise<ContextManifest> {
  const manifest = await readManifest(options.storage, options.id);
  const mountPath = options.mountPath ?? options.runtime.defaultMountPath?.(options.id) ?? defaultMountPath(options.id);
  const remotePath = remoteImagePath(options.id);
  const remoteTreePath = remoteBundlePath(options.id);
  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-save-"));
  try {
    const persistencePolicy = resolvePersistencePolicy(options.persistencePolicy ?? manifest.persistencePolicy);
    const nextGeneration = manifest.generation + 1;
    const version = await snapshotContextVersion({
      runtime: options.runtime,
      mountPath,
      generation: nextGeneration,
      parentGeneration: manifest.generation,
      author: options.author ?? options.owner ?? "contextsdk",
      message: options.message ?? "save context",
      policy: persistencePolicy,
    });
    await options.runtime.flush?.(mountPath);
    assertSuccess(await options.runtime.run(packBundleScript(remoteTreePath, mountPath, persistencePolicy), { user: "root" }), "pack context tree");
    const treePath = join(tempDir, "current.tree.tar.zst");
    const encryptedTreePath = join(tempDir, "current.tree.tar.zst.enc");
    await options.runtime.downloadFile(remoteTreePath, treePath);
    const treeEncryption = await encryptFile(treePath, encryptedTreePath, options.encryption);
    const rawPath = join(tempDir, "current.img");
    const encryptedPath = join(tempDir, "current.img.enc");
    let imageEncryption = manifest.imageEncryption;
    let sizeBytes = (await stat(treePath)).size;
    const isDirectoryBundle = Boolean(options.runtime.capabilities?.directoryBundle) && !options.runtime.capabilities?.loopExt4;
    const shouldPersistExt4Image = !isDirectoryBundle && (manifest.format === "ext4" || Boolean(manifest.imageEncryption));
    if (!isDirectoryBundle) {
      assertSuccess(await options.runtime.run(saveScript(remotePath, mountPath), { user: "root" }), "save context");
      if (shouldPersistExt4Image) {
        await options.runtime.downloadFile(remotePath, rawPath);
        await validateExt4Image(rawPath);
        imageEncryption = await encryptFile(rawPath, encryptedPath, options.encryption);
        sizeBytes = (await stat(rawPath)).size;
      }
    }
    const updated: ContextManifest = {
      ...manifest,
      format: "tree",
      filesystem: "tree",
      generation: nextGeneration,
      encryption: treeEncryption,
      treeEncryption,
      imageEncryption,
      latestVersion: version,
      versions: [...(manifest.versions ?? []), version],
      persistencePolicy,
      runtimeState: await runtimeStateForManifest(options.runtime, options.runtimeState, manifest.runtimeState),
      updatedAt: new Date().toISOString(),
      sizeBytes,
    };
    await options.storage.putObject(manifest.treeKey, await readFile(encryptedTreePath));
    if (shouldPersistExt4Image && imageEncryption) {
      await options.storage.putObject(manifest.imageKey, await readFile(encryptedPath));
    }
    await options.storage.putObject(contextKeys(options.id).manifest, JSON.stringify(updated, null, 2));
    if (options.cleanupRemote ?? true) {
      await options.runtime.run(`rm -f ${shellQuote(remotePath)} ${shellQuote(remoteTreePath)}`, { user: "root" });
    }
    return updated;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function detachContext(options: DetachContextOptions): Promise<void> {
  const mountPath = options.mountPath ?? options.runtime.defaultMountPath?.(options.id) ?? defaultMountPath(options.id);
  const remotePath = remoteImagePath(options.id);
  const remoteTreePath = remoteBundlePath(options.id);
  const isDirectoryBundle = Boolean(options.runtime.capabilities?.directoryBundle) && !options.runtime.capabilities?.loopExt4;
  await options.runtime.run(
    isDirectoryBundle
      ? detachDirectoryScript(remoteTreePath, mountPath, options.cleanupRemote ?? true)
      : detachScript(remotePath, mountPath, options.cleanupRemote ?? true),
    { user: "root" },
  );
  await releaseLock({
    storage: options.storage,
    contextId: options.id,
    owner: options.owner,
    force: options.forceUnlock,
  });
}

export async function withContext<T>(
  options: AttachContextOptions,
  fn: (mounted: MountedContext) => Promise<T>,
): Promise<T> {
  const mounted = await attachContext(options);
  try {
    const result = await fn(mounted);
    await saveContext({ ...options, owner: mounted.owner, mountPath: mounted.mountPath });
    return result;
  } finally {
    await detachContext({ storage: options.storage, runtime: options.runtime, id: options.id, owner: mounted.owner, mountPath: mounted.mountPath }).catch(() => undefined);
    await rm(mounted.localTempDir, { recursive: true, force: true });
  }
}

export async function provisionContextRuntime(options: RunWithContextOptions): Promise<{ runtime: RuntimeAdapter }> {
  if (options.runtime) {
    return { runtime: options.runtime };
  }
  if (!options.provisioner) {
    throw new ContextSDKError("runtime or provisioner is required");
  }
  return { runtime: await options.provisioner.createSessionRuntime({ contextId: options.id }) };
}

export async function startContextSession(options: StartContextSessionOptions): Promise<ContextSession> {
  if (options.createIfMissing && !await options.storage.headObject(contextKeys(options.id).manifest)) {
    await createContext({
      id: options.id,
      size: options.size ?? "256M",
      storage: options.storage,
      encryption: options.encryption,
      persistencePolicy: options.persistencePolicy,
    });
  }
  const mounted = await attachContext(options);
  return buildSession(options.runtime, mounted);
}

export async function saveContextSession(
  session: ContextSession,
  options: Omit<SaveContextOptions, "id" | "runtime" | "mountPath" | "owner">,
): Promise<ContextManifest> {
  return saveContext({
    ...options,
    id: session.id,
    runtime: session.runtime,
    mountPath: session.mountPath,
    owner: session.owner,
  });
}

export async function checkpointContextSession(
  session: ContextSession,
  options: CheckpointContextOptions & {
    storage: SaveContextOptions["storage"];
    encryption: SaveContextOptions["encryption"];
  },
): Promise<ContextManifest> {
  const manifest = await readManifest(options.storage, session.id);
  const persistencePolicy = resolvePersistencePolicy(options.persistencePolicy ?? manifest.persistencePolicy);
  const keys = contextKeys(session.id);
  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-checkpoint-"));
  const remoteTreePath = remoteBundlePath(session.id);
  try {
    await session.runtime.flush?.(session.mountPath);
    assertSuccess(await session.runtime.run(packBundleScript(remoteTreePath, session.mountPath, persistencePolicy), { user: "root" }), "checkpoint context tree");
    const treePath = join(tempDir, "checkpoint.tree.tar.zst");
    const encryptedTreePath = join(tempDir, "checkpoint.tree.tar.zst.enc");
    await session.runtime.downloadFile(remoteTreePath, treePath);
    const treeEncryption = await encryptFile(treePath, encryptedTreePath, options.encryption);
    const checkpointGeneration = (manifest.checkpointGeneration ?? 0) + 1;
    const checkpoint = {
      version: 1 as const,
      generation: checkpointGeneration,
      reason: options.reason ?? "checkpoint",
      timestamp: new Date().toISOString(),
      treeKey: `${keys.checkpoints}/${String(checkpointGeneration).padStart(8, "0")}.tree.tar.zst.enc`,
      sizeBytes: (await stat(treePath)).size,
    };
    const encrypted = await readFile(encryptedTreePath);
    const updated: ContextManifest = {
      ...manifest,
      format: "tree",
      filesystem: "tree",
      checkpointGeneration,
      latestCheckpoint: checkpoint,
      encryption: treeEncryption,
      treeEncryption,
      persistencePolicy,
      runtimeState: await runtimeStateForManifest(session.runtime, "auto", manifest.runtimeState),
      updatedAt: checkpoint.timestamp,
      sizeBytes: checkpoint.sizeBytes,
    };
    await options.storage.putObject(checkpoint.treeKey, encrypted);
    await options.storage.putObject(manifest.treeKey, encrypted);
    await options.storage.putObject(keys.manifest, JSON.stringify(updated, null, 2));
    return updated;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function endContextSession(
  session: ContextSession,
  options: Omit<DetachContextOptions, "id" | "runtime" | "mountPath" | "owner">,
): Promise<void> {
  await detachContext({
    ...options,
    id: session.id,
    runtime: session.runtime,
    mountPath: session.mountPath,
    owner: session.owner,
  });
  await rm(session.mounted.localTempDir, { recursive: true, force: true });
}

export async function runWithContext<T>(
  options: RunWithContextOptions,
  fn: (session: ContextSession) => Promise<T>,
): Promise<T> {
  const createdRuntime = !options.runtime;
  const { runtime } = await provisionContextRuntime(options);
  const session = await startContextSession({ ...options, runtime });
  let shouldSave = true;
  const checkpointTimer = startCheckpointTimer(session, options);
  const signalFinalizer = installSignalFinalizer(async signal => {
    checkpointTimer.stop();
    await saveContextSession(session, {
      storage: options.storage,
      encryption: options.encryption,
      author: options.author,
      message: options.message ?? `runWithContext ${signal} save`,
      persistencePolicy: options.persistencePolicy,
      runtimeState: options.runtimeState,
    }).catch(() => undefined);
    await endContextSession(session, {
      storage: options.storage,
    }).catch(() => undefined);
    const finalizedRuntimeState = options.runtimeState === "disabled"
      ? undefined
      : await runtime.finalizeRuntimeState?.().catch(() => undefined);
    if (finalizedRuntimeState) {
      await updateManifestRuntimeState(options.storage, options.id, finalizedRuntimeState).catch(() => undefined);
    }
    if (createdRuntime) {
      await options.provisioner?.destroyRuntime?.(runtime).catch(() => undefined);
    }
  });
  try {
    const result = await fn(session);
    await saveContextSession(session, {
      storage: options.storage,
      encryption: options.encryption,
      author: options.author,
      message: options.message ?? "runWithContext save",
      persistencePolicy: options.persistencePolicy,
      runtimeState: options.runtimeState,
    });
    shouldSave = false;
    return result;
  } catch (error) {
    if (options.saveOnError ?? true) {
      await session.logs.append(`runWithContext failure: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      await saveContextSession(session, {
        storage: options.storage,
        encryption: options.encryption,
        author: options.author,
        message: options.message ?? "runWithContext failure save",
        persistencePolicy: options.persistencePolicy,
        runtimeState: options.runtimeState,
      }).catch(() => undefined);
      shouldSave = false;
    }
    throw error;
  } finally {
    checkpointTimer.stop();
    signalFinalizer.dispose();
    if (shouldSave) {
      await saveContextSession(session, {
        storage: options.storage,
        encryption: options.encryption,
        author: options.author,
        message: options.message ?? "runWithContext final save",
        persistencePolicy: options.persistencePolicy,
        runtimeState: options.runtimeState,
      }).catch(() => undefined);
    }
    await endContextSession(session, {
      storage: options.storage,
    }).catch(() => undefined);
    const finalizedRuntimeState = options.runtimeState === "disabled"
      ? undefined
      : await runtime.finalizeRuntimeState?.().catch(() => undefined);
    if (createdRuntime) {
      await options.provisioner?.destroyRuntime?.(runtime).catch(() => undefined);
    }
    const runtimeState = finalizedRuntimeState ?? (options.runtimeState === "disabled" ? undefined : await runtime.getRuntimeState?.().catch(() => undefined));
    if (runtimeState) {
      await updateManifestRuntimeState(options.storage, options.id, runtimeState).catch(() => undefined);
    }
  }
}

export function buildSession(runtime: RuntimeAdapter, mounted: MountedContext): ContextSession {
  const files = new MountedContextFileManager(runtime, mounted.mountPath);
  return {
    id: mounted.id,
    owner: mounted.owner,
    runtimeId: mounted.runtimeId,
    mountPath: mounted.mountPath,
    runtime,
    mounted,
    files,
    memory: createMemoryApi(files),
    artifacts: createArtifactsApi(files),
    logs: createLogsApi(files),
  };
}

export async function snapshotContextVersion(options: {
  runtime: RuntimeAdapter;
  mountPath: string;
  generation: number;
  parentGeneration: number | null;
  author: string;
  message: string;
  policy?: Parameters<typeof snapshotScript>[0]["policy"];
}): Promise<ContextVersionRecord> {
  const result = await options.runtime.run(snapshotScript(options), { user: "root" });
  assertSuccess(result, "snapshot context version");
  const line = result.stdout.split("\n").find(line => line.startsWith("CONTEXTSDK_VERSION_JSON="));
  if (!line) {
    throw new ContextSDKError("snapshot did not emit version metadata");
  }
  return JSON.parse(line.slice("CONTEXTSDK_VERSION_JSON=".length)) as ContextVersionRecord;
}

export async function readManifest(storage: { getObject(key: string): Promise<Buffer> }, id: string): Promise<ContextManifest> {
  return normalizeManifest(JSON.parse((await storage.getObject(contextKeys(id).manifest)).toString("utf8")), id);
}

export async function statusContext(options: { id: string; storage: { getObject(key: string): Promise<Buffer>; headObject(key: string): Promise<unknown> } }): Promise<{ manifest: ContextManifest | null; lock: unknown }> {
  const manifest = await options.storage.headObject(contextKeys(options.id).manifest)
    ? await readManifest(options.storage, options.id)
    : null;
  return { manifest, lock: await readLock(options.storage as never, options.id) };
}

function parseLoopDevice(stdout: string): string | undefined {
  const line = stdout.split("\n").find(line => line.startsWith("CONTEXTSDK_MOUNT_JSON="));
  if (!line) {
    return undefined;
  }
  try {
    return JSON.parse(line.slice("CONTEXTSDK_MOUNT_JSON=".length)).loopDevice;
  } catch {
    return undefined;
  }
}

function normalizeManifest(input: ContextManifest, id: string): ContextManifest {
  const keys = contextKeys(id);
  return {
    ...input,
    format: input.format ?? "ext4",
    filesystem: input.filesystem ?? "ext4",
    imageKey: input.imageKey ?? keys.image,
    treeKey: input.treeKey ?? keys.tree,
    treeEncryption: input.treeEncryption ?? (input.format === "tree" ? input.encryption : undefined),
    imageEncryption: input.imageEncryption ?? (input.format !== "tree" ? input.encryption : undefined),
    persistencePolicy: resolvePersistencePolicy(input.persistencePolicy),
  };
}

function startCheckpointTimer(session: ContextSession, options: RunWithContextOptions): { stop(): void } {
  const intervalMs = options.checkpoint?.enabled === false ? 0 : options.checkpoint?.intervalMs;
  if (!intervalMs || intervalMs <= 0) {
    return { stop() {} };
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    checkpointContextSession(session, {
      storage: options.storage,
      encryption: options.encryption,
      reason: "periodic",
      persistencePolicy: options.persistencePolicy,
    }).catch(() => undefined).finally(() => {
      running = false;
    });
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function runtimeStateForManifest(
  runtime: RuntimeAdapter,
  mode: SaveContextOptions["runtimeState"],
  fallback: RuntimeStateMetadata | undefined,
): Promise<RuntimeStateMetadata | undefined> {
  if (mode === "disabled") {
    return undefined;
  }
  return await runtime.getRuntimeState?.().catch(() => undefined) ?? fallback;
}

async function updateManifestRuntimeState(
  storage: SaveContextOptions["storage"],
  id: string,
  runtimeState: RuntimeStateMetadata,
): Promise<void> {
  const manifest = await readManifest(storage, id);
  await storage.putObject(contextKeys(id).manifest, JSON.stringify({
    ...manifest,
    runtimeState,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function installSignalFinalizer(onSignal: (signal: NodeJS.Signals) => Promise<void>): { dispose(): void } {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  let running = false;
  for (const signal of signals) {
    const handler = () => {
      if (running) {
        return;
      }
      running = true;
      void onSignal(signal)
        .catch(() => undefined)
        .finally(() => {
          process.exit(signal === "SIGINT" ? 130 : 143);
        });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    dispose() {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
    },
  };
}

async function createAndEncryptExt4(options: {
  rawPath: string;
  encryptedPath: string;
  stagingDir: string;
  sizeBytes: number;
  contextId: string;
  encryption: CreateContextOptions["encryption"];
}) {
  await createExt4Image({
    imagePath: options.rawPath,
    stagingDir: options.stagingDir,
    sizeBytes: options.sizeBytes,
    contextId: options.contextId,
  });
  return encryptFile(options.rawPath, options.encryptedPath, options.encryption);
}
