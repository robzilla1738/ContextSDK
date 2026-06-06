import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptFile, decryptFile } from "./crypto.js";
import { ContextLockError, ContextSDKError, StorageConditionError } from "./errors.js";
import { createArtifactsApi, createLogsApi, createMemoryApi, MountedContextFileManager } from "./file-manager.js";
import { createExt4Image, directorySizeBytes, parseSize, validateExt4Image } from "./local-image.js";
import { acquireLock, assertLockOwnership, defaultLockTtlMs, makeOwner, readLock, releaseLock, renewLock } from "./lock.js";
import { contextKeys, defaultLayout, defaultMountPath, generationDataKeys, isReplaceableDataKey, remoteBundlePath, remoteImagePath } from "./paths.js";
import { resolvePersistencePolicy } from "./persistence-policy.js";
import { assertSuccess } from "./runtime.js";
import { detachDirectoryScript, detachScript, ensureRuntimeToolsScript, mountScript, packBundleScript, saveScript, unpackBundleScript } from "./scripts.js";
import { shellQuote } from "./shell.js";
import { assertSafeArchive, packContextTree, prepareContextTree, unpackContextTree } from "./tree-bundle.js";
import { snapshotScript } from "./versioning.js";
import type { RuntimeAdapter } from "./runtime.js";
import type { StorageAdapter } from "./storage.js";
import type {
  AttachContextOptions,
  CheckpointContextOptions,
  ContextLock,
  ContextManifest,
  ContextSession,
  ContextVersionRecord,
  CreateContextOptions,
  DetachContextOptions,
  MountedContext,
  RecoveryInfo,
  RuntimeStateMetadata,
  RunWithContextOptions,
  SaveContextOptions,
  SessionEvent,
  StartContextSessionOptions,
} from "./types.js";

/**
 * Manifest version records are summaries: full per-file indexes live inside the
 * bundle at .contextsdk/versions/<generation>.json. Keeping them in the manifest
 * would grow it without bound.
 */
const maxManifestVersions = 50;

/**
 * Remote pack/unpack/mount/save commands operate on whole context trees and can far
 * outlive provider SDK command-timeout defaults (e2b: 60 seconds). Fifteen minutes is
 * generous for multi-gigabyte bundles without letting a hung sandbox stall forever.
 */
const defaultCommandTimeoutMs = 15 * 60_000;

const sessionWriteQueues = new WeakMap<object, Promise<unknown>>();

/**
 * Serializes manifest-writing operations (save, checkpoint, runtime-state updates)
 * for one mounted session, so a periodic checkpoint cannot interleave with a save
 * and clobber the manifest generation it read.
 */
function withSessionWriteLock<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const previous = sessionWriteQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  sessionWriteQueues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function toManifestVersionRecord(record: ContextVersionRecord): ContextVersionRecord {
  return { ...record, files: [] };
}

export async function createContext(options: CreateContextOptions): Promise<ContextManifest> {
  const keys = contextKeys(options.id);
  const alreadyExisted = Boolean(await options.storage.headObject(keys.manifest));
  if (!options.force && alreadyExisted) {
    throw new ContextSDKError(`context already exists: ${options.id}`);
  }
  const previousManifest = alreadyExisted ? await readManifest(options.storage, options.id).catch(() => null) : null;
  const dataKeys = generationDataKeys(options.id, 1, randomBytes(4).toString("hex"));
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
      imageKey: dataKeys.image,
      treeKey: dataKeys.tree,
      encryption: format === "ext4" ? imageEncryption : treeEncryption,
      treeEncryption,
      imageEncryption: format === "ext4" ? imageEncryption : undefined,
      layout: [...defaultLayout],
      versions: [],
      persistencePolicy,
      createdAt: now,
      updatedAt: now,
    };
    const writtenKeys: string[] = [];
    try {
      await options.storage.putObject(dataKeys.tree, await readFile(encryptedTreePath));
      writtenKeys.push(dataKeys.tree);
      if (format === "ext4") {
        await options.storage.putObject(dataKeys.image, await readFile(encryptedPath));
        writtenKeys.push(dataKeys.image);
      }
      // ifNoneMatch closes the race between the head check above and this write:
      // when two creators race, exactly one manifest wins and the loser rolls back.
      await options.storage.putObject(
        keys.manifest,
        JSON.stringify(manifest, null, 2),
        options.force ? {} : { ifNoneMatch: "*" },
      );
    } catch (error) {
      // A fresh context that failed mid-create would otherwise leave orphaned objects.
      // Data objects are per-attempt keys, so rolling back our own writes is always safe.
      await Promise.allSettled(writtenKeys.map(key => options.storage.deleteObject(key)));
      if (error instanceof StorageConditionError) {
        throw new ContextSDKError(`context already exists: ${options.id}`);
      }
      throw error;
    }
    if (options.force && alreadyExisted) {
      // Force-recreate replaces a whole context: reclaim every historical data and
      // checkpoint object from the old incarnation, not just the prior current keys.
      await pruneContextDataObjects(options.storage, options.id, new Set([dataKeys.tree, dataKeys.image]));
    } else {
      await gcSupersededDataObjects(options.storage, options.id, previousManifest, manifest);
    }
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
  const { adopted } = await acquireLock({
    storage: options.storage,
    contextId: options.id,
    runtimeId: options.runtime.id,
    owner,
    ttlMs: options.lockTtlMs ?? defaultLockTtlMs,
    force: options.forceUnlock,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-attach-"));
  const commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  try {
    const encryptedPath = join(tempDir, "current.img.enc");
    const rawPath = join(tempDir, "current.img");
    const treeEncryptedPath = join(tempDir, "current.tree.tar.zst.enc");
    const treePath = join(tempDir, "current.tree.tar.zst");
    const treeRoot = join(tempDir, "tree");
    // Tree contexts attach via the unprivileged directory-bundle path whenever the
    // runtime supports it: it needs no host ext4 tooling and no loop devices. The
    // loop-ext4 path is reserved for contexts whose current data is an ext4 image.
    const useDirectoryBundle = Boolean(options.runtime.capabilities?.directoryBundle)
      && (manifest.format === "tree" || !options.runtime.capabilities?.loopExt4);
    if (useDirectoryBundle || manifest.format === "tree") {
      await writeFile(treeEncryptedPath, await options.storage.getObject(manifest.treeKey), { mode: 0o600 });
      await decryptFile(treeEncryptedPath, treePath, manifest.treeEncryption ?? manifest.encryption, options.encryption);
      if (useDirectoryBundle) {
        await assertSafeArchive(treePath);
        await options.runtime.uploadFile(treePath, remoteTreePath);
        const mountResult = await options.runtime.run(unpackBundleScript(remoteTreePath, mountPath, manifest.persistencePolicy), { user: "root", timeoutMs: commandTimeoutMs });
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
      // Size the image from the decompressed tree: manifest.sizeBytes for tree contexts
      // records the zstd-compressed bundle, which can be many times smaller than the
      // data mkfs.ext4 -d has to lay out.
      const treeBytes = await directorySizeBytes(treeRoot);
      const sizeBytes = Math.max(
        manifest.format === "ext4" ? manifest.sizeBytes ?? 0 : 0,
        Math.ceil(treeBytes * 1.5) + 64 * 1024 * 1024,
        256 * 1024 * 1024,
      );
      await createExt4Image({ imagePath: rawPath, stagingDir: treeRoot, sizeBytes, contextId: options.id, useExistingStagingDir: true });
    } else {
      await writeFile(encryptedPath, await options.storage.getObject(manifest.imageKey), { mode: 0o600 });
      await decryptFile(encryptedPath, rawPath, manifest.imageEncryption ?? manifest.encryption, options.encryption);
      await validateExt4Image(rawPath);
    }
    await options.runtime.uploadFile(rawPath, remotePath);
    assertSuccess(await options.runtime.run(ensureRuntimeToolsScript(), { user: "root", timeoutMs: commandTimeoutMs }), "runtime tool check");
    const mountResult = await options.runtime.run(mountScript(remotePath, mountPath), { user: "root", timeoutMs: commandTimeoutMs });
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
    // An adopted lock belongs to a live session that is re-attaching (recovery);
    // releasing it here would strand that session without exclusivity.
    if (!adopted) {
      await releaseLock({ storage: options.storage, contextId: options.id, owner, force: true }).catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function saveContext(options: SaveContextOptions): Promise<ContextManifest> {
  if (options.owner) {
    // A writer whose lock expired and was taken over must not clobber the new
    // writer's data. Callers without an owner (manual CLI saves) skip this check.
    await assertLockOwnership({ storage: options.storage, contextId: options.id, owner: options.owner });
  }
  const { manifest, etag: manifestEtag } = await readManifestWithMeta(options.storage, options.id);
  const mountPath = options.mountPath ?? options.runtime.defaultMountPath?.(options.id) ?? defaultMountPath(options.id);
  const remotePath = remoteImagePath(options.id);
  const remoteTreePath = remoteBundlePath(options.id);
  const commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-save-"));
  try {
    const persistencePolicy = resolvePersistencePolicy(options.persistencePolicy ?? manifest.persistencePolicy);
    const nextGeneration = manifest.generation + 1;
    const dataKeys = generationDataKeys(options.id, nextGeneration, randomBytes(4).toString("hex"));
    const version = await snapshotContextVersion({
      runtime: options.runtime,
      mountPath,
      generation: nextGeneration,
      parentGeneration: manifest.generation,
      author: options.author ?? options.owner ?? "contextsdk",
      message: options.message ?? "save context",
      policy: persistencePolicy,
      timeoutMs: commandTimeoutMs,
    });
    await options.runtime.flush?.(mountPath);
    assertSuccess(await options.runtime.run(packBundleScript(remoteTreePath, mountPath, persistencePolicy), { user: "root", timeoutMs: commandTimeoutMs }), "pack context tree");
    const treePath = join(tempDir, "current.tree.tar.zst");
    const encryptedTreePath = join(tempDir, "current.tree.tar.zst.enc");
    await options.runtime.downloadFile(remoteTreePath, treePath);
    const treeEncryption = await encryptFile(treePath, encryptedTreePath, options.encryption);
    const rawPath = join(tempDir, "current.img");
    const encryptedPath = join(tempDir, "current.img.enc");
    let imageEncryption = manifest.imageEncryption;
    let sizeBytes = (await stat(treePath)).size;
    // Mirror the attach-time mount-mode decision; session callers pass the actual
    // mounted mode so a re-derivation can never disagree with what attach did.
    const mode = options.mode ?? (
      Boolean(options.runtime.capabilities?.directoryBundle) && (manifest.format === "tree" || !options.runtime.capabilities?.loopExt4)
        ? "directoryBundle"
        : "loopExt4"
    );
    const isLoopMounted = mode === "loopExt4";
    const shouldPersistExt4Image = isLoopMounted && (manifest.format === "ext4" || Boolean(manifest.imageEncryption));
    if (isLoopMounted) {
      assertSuccess(await options.runtime.run(saveScript(remotePath, mountPath), { user: "root", timeoutMs: commandTimeoutMs }), "save context");
      if (shouldPersistExt4Image) {
        await options.runtime.downloadFile(remotePath, rawPath);
        await validateExt4Image(rawPath);
        imageEncryption = await encryptFile(rawPath, encryptedPath, options.encryption);
        sizeBytes = (await stat(rawPath)).size;
      }
    }
    // An explicit ext4 context stays ext4 only when this save refreshed the image;
    // otherwise the filtered tree bundle is the only current data and the manifest
    // must say so, or a later loop-ext4 attach would load a stale image.
    const keepExt4Format = manifest.format === "ext4" && shouldPersistExt4Image && Boolean(imageEncryption);
    const versionSummary = toManifestVersionRecord(version);
    const updated: ContextManifest = {
      ...manifest,
      format: keepExt4Format ? "ext4" : "tree",
      filesystem: keepExt4Format ? "ext4" : "tree",
      generation: nextGeneration,
      treeKey: dataKeys.tree,
      imageKey: shouldPersistExt4Image && imageEncryption ? dataKeys.image : manifest.imageKey,
      encryption: treeEncryption,
      treeEncryption,
      imageEncryption,
      latestVersion: versionSummary,
      versions: [...(manifest.versions ?? []), versionSummary].slice(-maxManifestVersions),
      persistencePolicy,
      runtimeState: await runtimeStateForManifest(options.runtime, options.runtimeState, manifest.runtimeState),
      updatedAt: new Date().toISOString(),
      sizeBytes,
    };
    // Commit protocol: data objects land under fresh per-generation keys first, then a
    // single conditional manifest write flips to them. A crash before the manifest write
    // leaves the previous generation fully intact; a manifest that exists always points
    // at ciphertext its recorded encryption metadata can decrypt.
    const writtenKeys: string[] = [];
    try {
      await options.storage.putObject(dataKeys.tree, await readFile(encryptedTreePath));
      writtenKeys.push(dataKeys.tree);
      if (shouldPersistExt4Image && imageEncryption) {
        await options.storage.putObject(dataKeys.image, await readFile(encryptedPath));
        writtenKeys.push(dataKeys.image);
      }
      if (options.owner) {
        // Re-assert at the commit point: the check at entry can be minutes stale after
        // packing and encrypting a large tree.
        await assertLockOwnership({ storage: options.storage, contextId: options.id, owner: options.owner });
      }
      await options.storage.putObject(
        contextKeys(options.id).manifest,
        JSON.stringify(updated, null, 2),
        manifestEtag ? { ifMatch: manifestEtag } : {},
      );
    } catch (error) {
      await Promise.allSettled(writtenKeys.map(key => options.storage.deleteObject(key)));
      if (error instanceof StorageConditionError) {
        throw new ContextLockError(
          `context manifest for ${options.id} changed during save (concurrent writer or lock takeover); save aborted`,
        );
      }
      throw error;
    }
    await gcSupersededDataObjects(options.storage, options.id, manifest, updated);
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
  const isDirectoryBundle = options.mode
    ? options.mode === "directoryBundle"
    : Boolean(options.runtime.capabilities?.directoryBundle) && !options.runtime.capabilities?.loopExt4;
  await options.runtime.run(
    isDirectoryBundle
      ? detachDirectoryScript(remoteTreePath, mountPath, options.cleanupRemote ?? true)
      : detachScript(remotePath, mountPath, options.cleanupRemote ?? true),
    { user: "root", timeoutMs: options.commandTimeoutMs ?? defaultCommandTimeoutMs },
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
  const lockRenewal = startLockRenewalTimer({
    storage: options.storage,
    contextId: options.id,
    owner: mounted.owner,
    lockTtlMs: options.lockTtlMs,
    runtime: options.runtime,
  });
  try {
    const result = await fn(mounted);
    await saveContext({ ...options, owner: mounted.owner, mountPath: mounted.mountPath, mode: mounted.mode });
    return result;
  } finally {
    lockRenewal.stop();
    await detachContext({ storage: options.storage, runtime: options.runtime, id: options.id, owner: mounted.owner, mountPath: mounted.mountPath, mode: mounted.mode }).catch(error => {
      process.emitWarning(`contextSDK: detach failed for ${options.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
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
  return withSessionWriteLock(session.mounted, () => saveContext({
    ...options,
    id: session.id,
    runtime: session.runtime,
    mountPath: session.mountPath,
    owner: session.owner,
    mode: session.mounted.mode,
  }));
}

export async function checkpointContextSession(
  session: ContextSession,
  options: CheckpointContextOptions & {
    storage: SaveContextOptions["storage"];
    encryption: SaveContextOptions["encryption"];
  },
): Promise<ContextManifest> {
  return withSessionWriteLock(session.mounted, () => checkpointContextSessionInner(session, options));
}

async function checkpointContextSessionInner(
  session: ContextSession,
  options: CheckpointContextOptions & {
    storage: SaveContextOptions["storage"];
    encryption: SaveContextOptions["encryption"];
  },
): Promise<ContextManifest> {
  if (session.owner) {
    await assertLockOwnership({ storage: options.storage, contextId: session.id, owner: session.owner });
  }
  const { manifest, etag: manifestEtag } = await readManifestWithMeta(options.storage, session.id);
  const persistencePolicy = resolvePersistencePolicy(options.persistencePolicy ?? manifest.persistencePolicy);
  const keys = contextKeys(session.id);
  const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-checkpoint-"));
  const remoteTreePath = remoteBundlePath(session.id);
  const commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
  try {
    await session.runtime.flush?.(session.mountPath);
    assertSuccess(await session.runtime.run(packBundleScript(remoteTreePath, session.mountPath, persistencePolicy), { user: "root", timeoutMs: commandTimeoutMs }), "checkpoint context tree");
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
    // The checkpoint object becomes the context's current tree by pointer flip; writing
    // the bytes a second time at the old treeKey would reintroduce the in-place
    // overwrite that can strand a manifest with stale encryption metadata.
    const updated: ContextManifest = {
      ...manifest,
      format: "tree",
      filesystem: "tree",
      checkpointGeneration,
      latestCheckpoint: checkpoint,
      treeKey: checkpoint.treeKey,
      encryption: treeEncryption,
      treeEncryption,
      persistencePolicy,
      runtimeState: await runtimeStateForManifest(session.runtime, "auto", manifest.runtimeState),
      updatedAt: checkpoint.timestamp,
      sizeBytes: checkpoint.sizeBytes,
    };
    try {
      await options.storage.putObject(checkpoint.treeKey, encrypted);
      if (session.owner) {
        await assertLockOwnership({ storage: options.storage, contextId: session.id, owner: session.owner });
      }
      await options.storage.putObject(
        keys.manifest,
        JSON.stringify(updated, null, 2),
        manifestEtag ? { ifMatch: manifestEtag } : {},
      );
    } catch (error) {
      await options.storage.deleteObject(checkpoint.treeKey).catch(() => undefined);
      if (error instanceof StorageConditionError) {
        throw new ContextLockError(
          `context manifest for ${session.id} changed during checkpoint (concurrent writer or lock takeover); checkpoint aborted`,
        );
      }
      throw error;
    }
    await gcSupersededDataObjects(options.storage, session.id, manifest, updated);
    return updated;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function endContextSession(
  session: ContextSession,
  options: Omit<DetachContextOptions, "id" | "runtime" | "mountPath" | "owner">,
): Promise<void> {
  try {
    await detachContext({
      ...options,
      id: session.id,
      runtime: session.runtime,
      mountPath: session.mountPath,
      owner: session.owner,
      mode: session.mounted.mode,
    });
  } finally {
    // The temp dir holds decrypted context data; it must go even when detach fails.
    if (session.mounted.localTempDir) {
      await rm(session.mounted.localTempDir, { recursive: true, force: true });
    }
  }
}

export async function runWithContext<T>(
  options: RunWithContextOptions,
  fn: (session: ContextSession) => Promise<T>,
): Promise<T> {
  const createdRuntime = !options.runtime;
  const recovery = options.recovery;
  const failureThreshold = Math.max(1, recovery?.failureThreshold ?? 3);
  const maxRecoveryAttempts = Math.max(1, recovery?.maxAttempts ?? 1);
  let { runtime } = await provisionContextRuntime(options);
  const session = await startContextSession({ ...options, runtime });
  let shouldSave = true;
  let recoveryAttempts = 0;

  // Heartbeat state machine: consecutive renew/keepAlive failures degrade the
  // session, and degradation fires one best-effort emergency checkpoint while the
  // sandbox may still be reachable. Re-provisioning never starts from a timer
  // callback — the recovery driver below runs in the main control flow.
  const heartbeat = { consecutiveFailures: 0, degraded: false };
  const onBeat = (beat: { ok: boolean; error?: Error }) => {
    if (beat.ok) {
      // A healthy beat ends the degradation: the sandbox answered keepAlive
      // and the lock renewed. A later relapse may degrade (and emergency-
      // checkpoint) again — intended for flapping infrastructure.
      heartbeat.consecutiveFailures = 0;
      heartbeat.degraded = false;
      return;
    }
    heartbeat.consecutiveFailures += 1;
    emitSessionEvent(options, { type: "heartbeat-failure", contextId: options.id, consecutiveFailures: heartbeat.consecutiveFailures, error: beat.error });
    if (heartbeat.consecutiveFailures < failureThreshold || heartbeat.degraded) {
      return;
    }
    heartbeat.degraded = true;
    emitSessionEvent(options, { type: "degraded", contextId: options.id, consecutiveFailures: heartbeat.consecutiveFailures, error: beat.error });
    if (recovery?.enabled && recovery.emergencyCheckpoint !== false) {
      checkpointContextSession(session, {
        storage: options.storage,
        encryption: options.encryption,
        reason: "emergency",
        persistencePolicy: options.persistencePolicy,
      }).then(() => {
        emitSessionEvent(options, { type: "emergency-checkpoint", contextId: options.id });
      }).catch(() => undefined);
    }
  };

  let checkpointTimer = startCheckpointTimer(session, options);
  let lockRenewal = startLockRenewalTimer({
    storage: options.storage,
    contextId: options.id,
    owner: session.owner,
    lockTtlMs: options.lockTtlMs,
    runtime,
    onBeat,
  });
  const startTimers = () => {
    checkpointTimer = startCheckpointTimer(session, options);
    lockRenewal = startLockRenewalTimer({
      storage: options.storage,
      contextId: options.id,
      owner: session.owner,
      lockTtlMs: options.lockTtlMs,
      runtime,
      onBeat,
    });
  };

  /**
   * Re-provisions a fresh sandbox and re-attaches the session from the latest
   * committed manifest. Returns true when fn should be re-invoked. The storage
   * lock is held by this process the whole way through: re-attach adopts it
   * (same owner), so no other writer can slip in between sandboxes.
   */
  const tryRecover = async (cause: unknown): Promise<boolean> => {
    if (!recovery?.enabled) {
      return false;
    }
    const reinvoke = Boolean(recovery.reinvoke);
    if (!createdRuntime || !options.provisioner || !(reinvoke || recovery.onRecover)) {
      // Caller-supplied runtimes cannot be re-provisioned, and without a
      // consumer (reinvoke or onRecover) a recovered session would be torn
      // straight back down — refuse instead of wasting a sandbox.
      emitSessionEvent(options, { type: "recovery-aborted", contextId: options.id, error: asError(cause) });
      return false;
    }
    // The probe is the ground truth: a degraded heartbeat alone (transient
    // control-plane hiccups, storage outages) must not destroy a sandbox that
    // still answers commands — with reinvoke that would replay fn's side effects.
    if (!await isRuntimeDead(runtime)) {
      return false; // fn failed on its own; the sandbox is healthy
    }
    lockRenewal.stop();
    // Only the dead runtime's keepAlive must stop — the lock that guards
    // exclusivity must not lapse while the replacement sandbox is provisioned,
    // a window that can outlive the remaining TTL. Renew immediately (the lock
    // may already be near expiry after a renewal outage), then keep renewing
    // with a lock-only timer until the re-attach adopts it.
    await renewLock({
      storage: options.storage,
      contextId: options.id,
      owner: session.owner,
      ttlMs: options.lockTtlMs ?? defaultLockTtlMs,
    }).catch(() => undefined);
    const recoveryRenewal = startLockRenewalTimer({
      storage: options.storage,
      contextId: options.id,
      owner: session.owner,
      lockTtlMs: options.lockTtlMs,
    });
    try {
      while (recoveryAttempts < maxRecoveryAttempts) {
        const attempt = ++recoveryAttempts;
        emitSessionEvent(options, { type: "recovery-start", contextId: options.id, attempt });
        try {
          // The old sandbox is dead or dying; tear it down best-effort. The
          // storage lock is deliberately NOT released.
          await options.provisioner.destroyRuntime?.(runtime).catch(() => undefined);
          // The superseded attach's temp dir holds decrypted context data.
          await rm(session.mounted.localTempDir, { recursive: true, force: true }).catch(() => undefined);
          ({ runtime } = await provisionContextRuntime(options));
          const mounted = await attachContext({ ...options, runtime, owner: session.owner });
          rebindSession(session, runtime, mounted);
          heartbeat.consecutiveFailures = 0;
          heartbeat.degraded = false;
          const manifest = await readManifest(options.storage, options.id);
          const info: RecoveryInfo = {
            attempt,
            generation: manifest.generation,
            checkpointGeneration: manifest.checkpointGeneration ?? 0,
            recoveredToCheckpoint: Boolean(manifest.latestCheckpoint && manifest.treeKey === manifest.latestCheckpoint.treeKey),
          };
          emitSessionEvent(options, {
            type: "recovery-success",
            contextId: options.id,
            attempt,
            recoveredToGeneration: info.generation,
            recoveredToCheckpointGeneration: info.checkpointGeneration,
          });
          // The recovered session is live from here on; onRecover and the
          // error-path save can run long, so the full heartbeat must resume
          // before control leaves the recovery driver. The lock-only timer
          // stops first so two renewers never race the same lock revision.
          recoveryRenewal.stop();
          startTimers();
          if (recovery.onRecover) {
            try {
              await recovery.onRecover(session, info);
            } catch (callbackError) {
              // The recovered session is live, but the caller's hook failed;
              // surface the original error instead of re-running fn blind.
              emitSessionEvent(options, { type: "recovery-failure", contextId: options.id, attempt, error: asError(callbackError) });
              return false;
            }
          }
          return reinvoke;
        } catch (recoveryError) {
          emitSessionEvent(options, { type: "recovery-failure", contextId: options.id, attempt, error: asError(recoveryError) });
        }
      }
      emitSessionEvent(options, { type: "recovery-aborted", contextId: options.id, attempt: recoveryAttempts, error: asError(cause) });
      return false;
    } finally {
      recoveryRenewal.stop();
    }
  };

  const signalFinalizer = installSignalFinalizer(async signal => {
    checkpointTimer.stop();
    lockRenewal.stop();
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
      await withSessionWriteLock(session.mounted, () => updateManifestRuntimeState(options.storage, options.id, finalizedRuntimeState)).catch(() => undefined);
    }
    if (createdRuntime) {
      await options.provisioner?.destroyRuntime?.(runtime).catch(() => undefined);
    }
  });
  try {
    for (;;) {
      try {
        const result = await fn(session);
        checkpointTimer.stop();
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
        checkpointTimer.stop();
        // tryRecover restarts the timers itself the moment the recovered
        // session is live, so onRecover and the error-path save below are
        // covered by lock renewal and keepAlive.
        if (await tryRecover(error)) {
          continue;
        }
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
        }
        // saveOnError: false means exactly that — the finally block must not save either.
        shouldSave = false;
        throw error;
      }
    }
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
    lockRenewal.stop();
    await endContextSession(session, {
      storage: options.storage,
    }).catch(error => {
      process.emitWarning(`contextSDK: session cleanup failed for ${options.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const finalizedRuntimeState = options.runtimeState === "disabled"
      ? undefined
      : await runtime.finalizeRuntimeState?.().catch(() => undefined);
    if (createdRuntime) {
      await options.provisioner?.destroyRuntime?.(runtime).catch(() => undefined);
    }
    const runtimeState = finalizedRuntimeState ?? (options.runtimeState === "disabled" ? undefined : await runtime.getRuntimeState?.().catch(() => undefined));
    if (runtimeState) {
      await withSessionWriteLock(session.mounted, () => updateManifestRuntimeState(options.storage, options.id, runtimeState)).catch(() => undefined);
    }
  }
}

function emitSessionEvent(options: RunWithContextOptions, event: SessionEvent): void {
  try {
    options.onSessionEvent?.(event);
  } catch {
    // A throwing telemetry callback must never corrupt the session lifecycle.
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Rejects after `ms` when the wrapped promise has not settled; the underlying operation is not cancelled. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Distinguishes "the sandbox died" from "the caller's code failed" after fn
 * throws: a healthy runtime answers a no-op command, a dead one cannot. Kept
 * short so a hung sandbox cannot stall the recovery decision.
 */
async function isRuntimeDead(runtime: RuntimeAdapter): Promise<boolean> {
  try {
    const result = await runtime.run(":", { timeoutMs: 10_000 });
    return result.exitCode !== 0;
  } catch {
    return true;
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

/**
 * Rebinds a session to a fresh runtime/mount after recovery — in place, because
 * the caller's fn and onRecover hold the session object by reference. The file
 * APIs close over runtime + mountPath and must be rebuilt; swapping `mounted`
 * also gives the recovered session a fresh withSessionWriteLock queue, so a
 * save stuck against the dead sandbox cannot block it. The owner is unchanged:
 * lock continuity across sandboxes is the point.
 */
export function rebindSession(session: ContextSession, runtime: RuntimeAdapter, mounted: MountedContext): void {
  const files = new MountedContextFileManager(runtime, mounted.mountPath);
  session.runtimeId = mounted.runtimeId;
  session.mountPath = mounted.mountPath;
  session.runtime = runtime;
  session.mounted = mounted;
  session.files = files;
  session.memory = createMemoryApi(files);
  session.artifacts = createArtifactsApi(files);
  session.logs = createLogsApi(files);
}

export async function snapshotContextVersion(options: {
  runtime: RuntimeAdapter;
  mountPath: string;
  generation: number;
  parentGeneration: number | null;
  author: string;
  message: string;
  policy?: Parameters<typeof snapshotScript>[0]["policy"];
  timeoutMs?: number;
}): Promise<ContextVersionRecord> {
  const result = await options.runtime.run(snapshotScript(options), { user: "root", timeoutMs: options.timeoutMs ?? defaultCommandTimeoutMs });
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

/**
 * Reads the manifest together with its storage ETag so writers can commit with
 * compare-and-swap. An adapter that returns no ETag degrades to unconditional
 * writes guarded only by the lock-ownership assertion.
 */
async function readManifestWithMeta(
  storage: Pick<StorageAdapter, "getObjectWithMetadata">,
  id: string,
): Promise<{ manifest: ContextManifest; etag?: string }> {
  const { body, metadata } = await storage.getObjectWithMetadata(contextKeys(id).manifest);
  return { manifest: normalizeManifest(JSON.parse(body.toString("utf8")), id), etag: metadata.etag };
}

/**
 * Best-effort cleanup of data objects a committed manifest no longer references.
 * Only generation-scoped and legacy "current.*" keys are eligible; checkpoint
 * history is never collected here.
 */
async function gcSupersededDataObjects(
  storage: Pick<StorageAdapter, "deleteObject">,
  id: string,
  previous: ContextManifest | null | undefined,
  current: ContextManifest,
): Promise<void> {
  if (!previous) {
    return;
  }
  const stale = new Set<string>();
  for (const key of [previous.treeKey, previous.imageKey]) {
    if (key && key !== current.treeKey && key !== current.imageKey && isReplaceableDataKey(id, key)) {
      stale.add(key);
    }
  }
  if (stale.size === 0) {
    return;
  }
  const results = await Promise.allSettled([...stale].map(key => storage.deleteObject(key)));
  for (const result of results) {
    if (result.status === "rejected") {
      process.emitWarning(`contextSDK: failed to delete superseded object for ${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }
}

/**
 * Deletes every tree/image/checkpoint data object for a context except the keys
 * in `keep`. Requires a listing-capable storage adapter; on adapters without
 * listObjects this is a no-op (the caller has already overwritten the current
 * objects, so only historical generations leak, which a later prune can reclaim).
 */
async function pruneContextDataObjects(
  storage: Pick<StorageAdapter, "deleteObject"> & Partial<Pick<StorageAdapter, "listObjects">>,
  id: string,
  keep: Set<string>,
): Promise<void> {
  if (!storage.listObjects) {
    return;
  }
  const prefixes = [`contexts/${id}/tree/`, `contexts/${id}/image/`, `contexts/${id}/checkpoints/`];
  const listings = await Promise.all(prefixes.map(prefix => storage.listObjects!(prefix).catch(() => [] as string[])));
  const victims = listings.flat().filter(key => !keep.has(key));
  const results = await Promise.allSettled(victims.map(key => storage.deleteObject(key)));
  for (const result of results) {
    if (result.status === "rejected") {
      process.emitWarning(`contextSDK: failed to prune object for ${id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }
}

export async function statusContext(options: {
  id: string;
  storage: Pick<StorageAdapter, "getObject" | "headObject">;
}): Promise<{ manifest: ContextManifest | null; lock: ContextLock | null }> {
  const manifest = await options.storage.headObject(contextKeys(options.id).manifest)
    ? await readManifest(options.storage, options.id)
    : null;
  return { manifest, lock: await readLock(options.storage, options.id) };
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
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Keeps the storage-backed lock alive for long sessions. Without renewal a
 * session outliving the lock TTL silently loses exclusivity and another writer
 * can take over mid-run. The same heartbeat drives the runtime's keepAlive so
 * countdown-based sandboxes (E2B, Vercel) are not killed mid-session either.
 */
function startLockRenewalTimer(options: {
  storage: StorageAdapter;
  contextId: string;
  owner: string;
  lockTtlMs?: number;
  runtime?: RuntimeAdapter;
  /** Reports each heartbeat outcome (lock renewal + keepAlive combined) so callers can detect a dying session. */
  onBeat?(beat: { ok: boolean; error?: Error }): void;
}): { stop(): void } {
  const ttlMs = options.lockTtlMs ?? defaultLockTtlMs;
  // Cadence must stay below BOTH the lock TTL and the sandbox lifetime: a large
  // lockTtlMs must not let the keepAlive fire after the sandbox has been auto-killed.
  const sandboxInterval = options.runtime?.sandboxTimeoutMs ? Math.floor(options.runtime.sandboxTimeoutMs / 3) : Infinity;
  const intervalMs = Math.max(Math.min(Math.floor(ttlMs / 3), sandboxInterval), 30_000);
  // A renewal or keepAlive call that hangs (wedged provider API, dead network)
  // must still count as a failed beat: an unsettled promise would otherwise
  // block the beat report forever and blind crash detection.
  const beatDeadlineMs = Math.min(intervalMs, 30_000);
  let warned = false;
  let stopped = false;
  const timer = setInterval(() => {
    const renewal = withDeadline(renewLock({
      storage: options.storage,
      contextId: options.contextId,
      owner: options.owner,
      ttlMs,
    }), beatDeadlineMs, `lock renewal for ${options.contextId} timed out`).catch(error => {
      if (!warned) {
        warned = true;
        process.emitWarning(`contextSDK: lock renewal failed for ${options.contextId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    });
    const keep = withDeadline(options.runtime?.keepAlive?.() ?? Promise.resolve(), beatDeadlineMs, `runtime keep-alive for ${options.contextId} timed out`).catch(error => {
      if (!warned) {
        warned = true;
        process.emitWarning(`contextSDK: runtime keep-alive failed for ${options.contextId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    });
    void Promise.allSettled([renewal, keep]).then(([renewResult, keepResult]) => {
      if (stopped || !options.onBeat) {
        // A beat already in flight when the timer stops must not feed a stale
        // failure into the next attempt's monitor.
        return;
      }
      const failure = renewResult.status === "rejected"
        ? renewResult.reason
        : keepResult.status === "rejected" ? keepResult.reason : undefined;
      options.onBeat(failure === undefined ? { ok: true } : { ok: false, error: asError(failure) });
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
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
  // Runtime-state metadata is a small follow-up write that can race a save from
  // another process; re-read and retry on CAS conflict instead of clobbering.
  for (let attempt = 0; ; attempt++) {
    const { manifest, etag } = await readManifestWithMeta(storage, id);
    try {
      await storage.putObject(contextKeys(id).manifest, JSON.stringify({
        ...manifest,
        runtimeState,
        updatedAt: new Date().toISOString(),
      }, null, 2), etag ? { ifMatch: etag } : {});
      return;
    } catch (error) {
      if (error instanceof StorageConditionError && attempt < 4) {
        continue;
      }
      // Runtime-state metadata (e.g. Vercel snapshot ids) is best-effort, but a
      // silent loss should at least be observable.
      process.emitWarning(`contextSDK: runtime-state update for ${id} lost to contention: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
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
