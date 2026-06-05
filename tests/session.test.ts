import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contextKeys } from "../src/paths.js";
import { attachContext, createContext, readManifest, runWithContext, saveContext } from "../src/context.js";
import { ContextLockError } from "../src/errors.js";
import { acquireLock, readLock } from "../src/lock.js";
import { MemoryStorage } from "../src/storage.js";
import type { PutObjectOptions } from "../src/storage.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";
import type { RuntimeProvisionOptions } from "../src/types.js";

class FakeRuntime implements RuntimeAdapter {
  id = "fake-runtime";
  commands: string[] = [];
  disposed = false;
  private image?: Buffer;
  finalized = false;

  async run(command: string): Promise<RuntimeCommandResult> {
    this.commands.push(command);
    if (command.includes("CONTEXTSDK_VERSION_JSON")) {
      return {
        exitCode: 0,
        stdout: `CONTEXTSDK_VERSION_JSON=${JSON.stringify({
          version: 1,
          generation: 2,
          parentGeneration: 1,
          timestamp: "2026-01-01T00:00:00Z",
          author: "test-agent",
          message: "test save",
          changedPaths: [{ path: "workspace/task.txt", type: "added" }],
          files: [{ path: "workspace/task.txt", size: 11, mode: "0o644", mtime: "2026-01-01T00:00:00Z", sha256: "abc" }],
        })}\n`,
        stderr: "",
      };
    }
    if (command.includes("CONTEXTSDK_MOUNT_JSON")) {
      return {
        exitCode: 0,
        stdout: 'CONTEXTSDK_MOUNT_JSON={"loopDevice":"/dev/loop0","mountPath":"/mnt/contextsdk/test","remoteImagePath":"/tmp/contextsdk-test.ext4.img"}\n',
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async uploadFile(localPath: string): Promise<void> {
    this.image = await readFile(localPath);
  }

  async downloadFile(_remotePath: string, localPath: string): Promise<void> {
    if (!this.image) {
      throw new Error("no uploaded image");
    }
    await writeFile(localPath, this.image);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  async getRuntimeState() {
    return {
      provider: "vercel",
      mode: "provider-persistence",
      sandboxName: "contextsdk-test",
      persistent: true,
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  async finalizeRuntimeState() {
    this.finalized = true;
    return {
      provider: "vercel",
      mode: "provider-persistence",
      sandboxName: "contextsdk-test",
      persistent: true,
      currentSnapshotId: "snap-final",
      updatedAt: "2026-01-01T00:00:01Z",
    };
  }
}

class RecordingStorage extends MemoryStorage {
  putKeys: string[] = [];

  async putObject(key: string, body: Buffer | Uint8Array | string, options?: PutObjectOptions): Promise<void> {
    this.putKeys.push(key);
    await super.putObject(key, body, options);
  }
}

describe("provisioned sessions", () => {
  it("runs provision, attach, callback, snapshot, save, detach, and destroy", async () => {
    const storage = new RecordingStorage();
    await createContext({ id: "test", size: "16M", storage, encryption: { passphrase: "passphrase" } });
    storage.putKeys = [];
    const runtime = new FakeRuntime();
    let provisionOptions: RuntimeProvisionOptions | undefined;
    await runWithContext({
      id: "test",
      storage,
      encryption: { passphrase: "passphrase" },
      provisioner: {
        async createSessionRuntime(options) {
          provisionOptions = options;
          return runtime;
        },
        async destroyRuntime(createdRuntime) {
          await createdRuntime.dispose?.();
        },
      },
      author: "test-agent",
      message: "test save",
    }, async session => {
      expect(session.mountPath).toBe("/mnt/contextsdk/test");
    });

    expect(runtime.commands.some(command => command.includes("losetup --find --show"))).toBe(true);
    expect(runtime.commands.some(command => command.includes("CONTEXTSDK_VERSION_JSON"))).toBe(true);
    expect(runtime.commands.some(command => command.includes("umount"))).toBe(true);
    expect(provisionOptions).toEqual({ contextId: "test" });
    expect(runtime.finalized).toBe(true);
    expect(runtime.disposed).toBe(true);
    await expect(readManifest(storage, "test")).resolves.toMatchObject({
      runtimeState: {
        provider: "vercel",
        mode: "provider-persistence",
        sandboxName: "contextsdk-test",
        currentSnapshotId: "snap-final",
      },
    });
    expect(storage.putKeys).not.toContain(contextKeys("test").image);
  });

  it("attempts cleanup when the callback fails", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "test-fail", size: "16M", storage, encryption: { passphrase: "passphrase" } });
    const runtime = new FakeRuntime();
    await expect(runWithContext({
      id: "test-fail",
      storage,
      encryption: { passphrase: "passphrase" },
      provisioner: {
        async createSessionRuntime() {
          return runtime;
        },
        async destroyRuntime(createdRuntime) {
          await createdRuntime.dispose?.();
        },
      },
    }, async () => {
      throw new Error("agent failed");
    })).rejects.toThrow(/agent failed/);

    expect(runtime.commands.some(command => command.includes("runWithContext failure"))).toBe(true);
    expect(runtime.commands.some(command => command.includes("CONTEXTSDK_VERSION_JSON"))).toBe(true);
    expect(runtime.disposed).toBe(true);
  });

  it("stores bounded version summaries without per-file indexes in the manifest", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "test-versions", size: "16M", storage, encryption: { passphrase: "passphrase" } });
    const runtime = new FakeRuntime();
    await runWithContext({
      id: "test-versions",
      storage,
      encryption: { passphrase: "passphrase" },
      provisioner: {
        async createSessionRuntime() {
          return runtime;
        },
      },
    }, async () => undefined);

    const manifest = await readManifest(storage, "test-versions");
    expect(manifest.versions?.length).toBeGreaterThan(0);
    expect(manifest.latestVersion?.changedPaths).toEqual([{ path: "workspace/task.txt", type: "added" }]);
    // Full per-file indexes live inside the bundle, not the manifest.
    expect(manifest.latestVersion?.files).toEqual([]);
    for (const version of manifest.versions ?? []) {
      expect(version.files).toEqual([]);
    }
  });

  it("releases the lock when attach fails", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "test-attach-fail", size: "16M", storage, encryption: { passphrase: "passphrase" } });
    const runtime = new FakeRuntime();
    runtime.uploadFile = async () => {
      throw new Error("upload exploded");
    };
    await expect(attachContext({
      id: "test-attach-fail",
      storage,
      encryption: { passphrase: "passphrase" },
      runtime,
    })).rejects.toThrow(/upload exploded/);
    await expect(readLock(storage, "test-attach-fail")).resolves.toBeNull();
  });

  it("refuses to save when the lock belongs to another writer", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "test-ownership", size: "16M", storage, encryption: { passphrase: "passphrase" } });
    await acquireLock({ storage, contextId: "test-ownership", runtimeId: "runtime-b", owner: "owner-b", ttlMs: 60_000 });
    const runtime = new FakeRuntime();
    await expect(saveContext({
      id: "test-ownership",
      storage,
      encryption: { passphrase: "passphrase" },
      runtime,
      owner: "owner-a",
    })).rejects.toThrow(ContextLockError);
    expect(runtime.commands).toHaveLength(0);
  });
});
