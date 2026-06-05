import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, runWithContext } from "../src/context.js";
import { readLock } from "../src/lock.js";
import { MemoryStorage } from "../src/storage.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";

const encryption = { passphrase: "renewal", scrypt: { cost: 1024, blockSize: 8, parallelization: 1 } };

class HeartbeatRuntime implements RuntimeAdapter {
  id = "heartbeat-runtime";
  capabilities = { directoryBundle: true, loopExt4: false };
  keepAliveCalls = 0;
  private payload?: Buffer;

  async run(command: string): Promise<RuntimeCommandResult> {
    if (command.includes("CONTEXTSDK_VERSION_JSON")) {
      return {
        exitCode: 0,
        stdout: `CONTEXTSDK_VERSION_JSON=${JSON.stringify({ version: 1, generation: 2, parentGeneration: 1, timestamp: "2026-01-01T00:00:00Z", author: "t", message: "m", changedPaths: [], files: [] })}\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async uploadFile(localPath: string): Promise<void> {
    this.payload = await readFile(localPath);
  }

  async downloadFile(_remote: string, localPath: string): Promise<void> {
    await writeFile(localPath, this.payload ?? Buffer.from(""));
  }

  async keepAlive(): Promise<void> {
    this.keepAliveCalls += 1;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session heartbeat", () => {
  it("renews the lock at TTL/3 and keeps the runtime alive on the same cadence", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    await createContext({ id: "heartbeat", size: "16M", storage, encryption });
    const runtime = new HeartbeatRuntime();

    await runWithContext({
      id: "heartbeat",
      storage,
      encryption,
      runtime,
      lockTtlMs: 90_000,
    }, async () => {
      const before = await readLock(storage, "heartbeat");
      expect(before).not.toBeNull();
      // TTL/3 = 30s; cross two renewal ticks.
      await vi.advanceTimersByTimeAsync(61_000);
      const after = await readLock(storage, "heartbeat");
      expect(Date.parse(after!.expiresAt)).toBeGreaterThan(Date.parse(before!.expiresAt));
      expect(runtime.keepAliveCalls).toBeGreaterThanOrEqual(2);
    });

    // Session ended: the lock is released and the heartbeat stopped.
    await expect(readLock(storage, "heartbeat")).resolves.toBeNull();
    const callsAtEnd = runtime.keepAliveCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runtime.keepAliveCalls).toBe(callsAtEnd);
  });
});
