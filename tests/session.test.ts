import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createContext, runWithContext } from "../src/context.js";
import { MemoryStorage } from "../src/storage.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";

class FakeRuntime implements RuntimeAdapter {
  id = "fake-runtime";
  commands: string[] = [];
  disposed = false;
  private image?: Buffer;

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
          changedPaths: [],
          files: [],
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
}

describe("provisioned sessions", () => {
  it("runs provision, attach, callback, snapshot, save, detach, and destroy", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "test", size: "16M", storage, encryption: { passphrase: "passphrase" } });
    const runtime = new FakeRuntime();
    await runWithContext({
      id: "test",
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
      author: "test-agent",
      message: "test save",
    }, async session => {
      expect(session.mountPath).toBe("/mnt/contextsdk/test");
    });

    expect(runtime.commands.some(command => command.includes("losetup --find --show"))).toBe(true);
    expect(runtime.commands.some(command => command.includes("CONTEXTSDK_VERSION_JSON"))).toBe(true);
    expect(runtime.commands.some(command => command.includes("umount"))).toBe(true);
    expect(runtime.disposed).toBe(true);
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
});
