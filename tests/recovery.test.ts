import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachContext, createContext, readManifest, runWithContext } from "../src/context.js";
import { acquireLock, readLock } from "../src/lock.js";
import { MemoryStorage } from "../src/storage.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";
import type { RecoveryInfo, SessionEvent } from "../src/types.js";

const encryption = { passphrase: "recovery", scrypt: { cost: 1024, blockSize: 8, parallelization: 1 } };

/**
 * Directory-bundle fake whose sandbox can "die": once dead, every command,
 * transfer, and keepAlive throws, exactly like a killed provider sandbox.
 * failKeepAlive models the softer failure (countdown API unreachable while
 * commands still work) that the heartbeat threshold is meant to catch.
 */
class CrashableRuntime implements RuntimeAdapter {
  capabilities = { directoryBundle: true, loopExt4: false };
  commands: string[] = [];
  keepAliveCalls = 0;
  dead = false;
  failKeepAlive = false;
  disposed = false;
  private payload?: Buffer;

  constructor(readonly id: string) {}

  async run(command: string): Promise<RuntimeCommandResult> {
    if (this.dead) {
      throw new Error(`${this.id} is dead`);
    }
    this.commands.push(command);
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
    if (this.dead) {
      throw new Error(`${this.id} is dead`);
    }
    this.payload = await readFile(localPath);
  }

  async downloadFile(_remote: string, localPath: string): Promise<void> {
    if (this.dead) {
      throw new Error(`${this.id} is dead`);
    }
    await writeFile(localPath, this.payload ?? Buffer.from(""));
  }

  async keepAlive(): Promise<void> {
    this.keepAliveCalls += 1;
    if (this.dead || this.failKeepAlive) {
      throw new Error(`${this.id} keepAlive failed`);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  async kill(): Promise<void> {
    this.dead = true;
  }
}

/** Hands out a fresh CrashableRuntime per provision call; optionally fails after the first. */
function makeProvisioner(behavior: { failAfterFirst?: boolean } = {}) {
  const runtimes: CrashableRuntime[] = [];
  const destroyed: string[] = [];
  return {
    runtimes,
    destroyed,
    provisioner: {
      async createSessionRuntime() {
        if (behavior.failAfterFirst && runtimes.length >= 1) {
          throw new Error("provider out of capacity");
        }
        const runtime = new CrashableRuntime(`sandbox-${runtimes.length + 1}`);
        runtimes.push(runtime);
        return runtime;
      },
      async destroyRuntime(runtime: RuntimeAdapter) {
        destroyed.push(runtime.id);
        await runtime.dispose?.();
      },
    },
  };
}

/** Polls with real timers; fake timers in these tests only cover setInterval. */
async function until(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session crash recovery", () => {
  it("declares the session degraded after consecutive heartbeat failures and fires an emergency checkpoint", async () => {
    // Only the heartbeat interval is faked; the emergency checkpoint runs on real I/O.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const storage = new MemoryStorage();
    await createContext({ id: "degraded", size: "16M", storage, encryption });
    const runtime = new CrashableRuntime("sandbox-1");
    const events: SessionEvent[] = [];

    await runWithContext({
      id: "degraded",
      storage,
      encryption,
      runtime,
      lockTtlMs: 90_000,
      recovery: { enabled: true, failureThreshold: 3 },
      onSessionEvent: event => events.push(event),
    }, async () => {
      runtime.failKeepAlive = true;
      // TTL/3 = 30s cadence; cross three failing beats.
      await vi.advanceTimersByTimeAsync(95_000);
      await until(() => events.some(event => event.type === "emergency-checkpoint"), "emergency checkpoint");
      runtime.failKeepAlive = false;
    });

    const failures = events.filter(event => event.type === "heartbeat-failure");
    expect(failures.length).toBeGreaterThanOrEqual(3);
    expect(failures[0]?.consecutiveFailures).toBe(1);
    expect(events.filter(event => event.type === "degraded")).toHaveLength(1);
    const manifest = await readManifest(storage, "degraded");
    expect(manifest.checkpointGeneration).toBe(1);
    expect(manifest.latestCheckpoint?.reason).toBe("emergency");
  });

  it("re-provisions, re-attaches with the same owner, and re-invokes fn when the sandbox dies", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "reinvoke", size: "16M", storage, encryption });
    const { runtimes, destroyed, provisioner } = makeProvisioner();
    const events: SessionEvent[] = [];
    const recoveries: RecoveryInfo[] = [];
    let invocations = 0;
    let firstOwner = "";
    let ownerDuringSecondRun = "";

    const result = await runWithContext({
      id: "reinvoke",
      storage,
      encryption,
      provisioner,
      recovery: {
        enabled: true,
        reinvoke: true,
        maxAttempts: 1,
        onRecover: (_session, info) => {
          recoveries.push(info);
        },
      },
      onSessionEvent: event => events.push(event),
    }, async session => {
      invocations += 1;
      if (invocations === 1) {
        firstOwner = session.owner;
        await session.runtime.kill?.();
        await session.runtime.run(":"); // dead sandbox: this throws, which is the crash
        throw new Error("kill did not take effect");
      }
      // The session object was rebound in place to the fresh sandbox.
      expect(session.runtime).toBe(runtimes[1]);
      expect(session.runtimeId).toBe("sandbox-2");
      expect(session.owner).toBe(firstOwner);
      ownerDuringSecondRun = (await readLock(storage, "reinvoke"))?.owner ?? "";
      return "done";
    });

    expect(result).toBe("done");
    expect(invocations).toBe(2);
    expect(runtimes).toHaveLength(2);
    // The lock never changed hands: the crashed session's owner held it throughout.
    expect(ownerDuringSecondRun).toBe(firstOwner);
    expect(recoveries).toEqual([
      { attempt: 1, generation: 1, checkpointGeneration: 0, recoveredToCheckpoint: false },
    ]);
    expect(events.map(event => event.type)).toEqual(["recovery-start", "recovery-success"]);
    // Dead sandbox torn down during recovery, fresh one at session end.
    expect(destroyed).toEqual(["sandbox-1", "sandbox-2"]);
    expect(runtimes[0]?.disposed).toBe(true);
    expect(runtimes[1]?.disposed).toBe(true);
    // Session ended normally: lock released.
    await expect(readLock(storage, "reinvoke")).resolves.toBeNull();
  });

  it("refuses recovery for caller-supplied runtimes and surfaces the original error", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "caller-supplied", size: "16M", storage, encryption });
    const runtime = new CrashableRuntime("sandbox-1");
    const events: SessionEvent[] = [];
    let invocations = 0;

    await expect(runWithContext({
      id: "caller-supplied",
      storage,
      encryption,
      runtime,
      recovery: { enabled: true, reinvoke: true },
      onSessionEvent: event => events.push(event),
    }, async session => {
      invocations += 1;
      await session.runtime.kill?.();
      throw new Error("original failure");
    })).rejects.toThrow(/original failure/);

    expect(invocations).toBe(1);
    expect(events.map(event => event.type)).toEqual(["recovery-aborted"]);
  });

  it("does not re-provision when nothing would consume the recovered session", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "no-consumer", size: "16M", storage, encryption });
    const { runtimes, provisioner } = makeProvisioner();
    const events: SessionEvent[] = [];

    await expect(runWithContext({
      id: "no-consumer",
      storage,
      encryption,
      provisioner,
      // enabled, but neither reinvoke nor onRecover: a recovered session would
      // be torn straight back down, so recovery must refuse instead.
      recovery: { enabled: true },
      onSessionEvent: event => events.push(event),
    }, async session => {
      await session.runtime.kill?.();
      throw new Error("original failure");
    })).rejects.toThrow(/original failure/);

    expect(runtimes).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual(["recovery-aborted"]);
  });

  it("aborts cleanly after maxAttempts when re-provisioning keeps failing", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "exhausted", size: "16M", storage, encryption });
    const { runtimes, provisioner } = makeProvisioner({ failAfterFirst: true });
    const events: SessionEvent[] = [];
    let invocations = 0;

    await expect(runWithContext({
      id: "exhausted",
      storage,
      encryption,
      provisioner,
      recovery: { enabled: true, reinvoke: true, maxAttempts: 2 },
      onSessionEvent: event => events.push(event),
    }, async session => {
      invocations += 1;
      await session.runtime.kill?.();
      throw new Error("original failure");
    })).rejects.toThrow(/original failure/);

    expect(invocations).toBe(1);
    expect(runtimes).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual([
      "recovery-start",
      "recovery-failure",
      "recovery-start",
      "recovery-failure",
      "recovery-aborted",
    ]);
  });

  it("recovers for onRecover without reinvoking, then surfaces the original error", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "no-reinvoke", size: "16M", storage, encryption });
    const { runtimes, provisioner } = makeProvisioner();
    const events: SessionEvent[] = [];
    const recoveries: RecoveryInfo[] = [];
    let invocations = 0;

    await expect(runWithContext({
      id: "no-reinvoke",
      storage,
      encryption,
      provisioner,
      recovery: {
        enabled: true,
        reinvoke: false,
        onRecover: (_session, info) => {
          recoveries.push(info);
        },
      },
      onSessionEvent: event => events.push(event),
    }, async session => {
      invocations += 1;
      await session.runtime.kill?.();
      throw new Error("original failure");
    })).rejects.toThrow(/original failure/);

    expect(invocations).toBe(1);
    expect(runtimes).toHaveLength(2);
    expect(recoveries).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual(["recovery-start", "recovery-success"]);
    // The recovered session was live for the error-path save and final cleanup.
    await expect(readLock(storage, "no-reinvoke")).resolves.toBeNull();
  });

  it("resumes lock renewal and keepAlive before onRecover runs", async () => {
    // Only intervals are faked; recovery's provisioning and attach run on real I/O.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const storage = new MemoryStorage();
    await createContext({ id: "hook-heartbeat", size: "16M", storage, encryption });
    const { runtimes, provisioner } = makeProvisioner();
    let keepAlivesDuringHook = 0;
    let lockExtendedDuringHook = false;

    await expect(runWithContext({
      id: "hook-heartbeat",
      storage,
      encryption,
      provisioner,
      lockTtlMs: 90_000,
      recovery: {
        enabled: true,
        onRecover: async () => {
          // A long-running hook must stay covered by the heartbeat: the lock
          // keeps renewing and the fresh sandbox keeps being kept alive.
          const fresh = runtimes[1]!;
          const before = fresh.keepAliveCalls;
          const lockBefore = await readLock(storage, "hook-heartbeat");
          await vi.advanceTimersByTimeAsync(61_000); // two TTL/3 beats
          await until(() => fresh.keepAliveCalls >= before + 2, "keepAlive during onRecover");
          keepAlivesDuringHook = fresh.keepAliveCalls - before;
          const lockAfter = await readLock(storage, "hook-heartbeat");
          lockExtendedDuringHook = Date.parse(lockAfter!.expiresAt) > Date.parse(lockBefore!.expiresAt);
        },
      },
    }, async session => {
      await session.runtime.kill?.();
      throw new Error("original failure");
    })).rejects.toThrow(/original failure/);

    expect(keepAlivesDuringHook).toBeGreaterThanOrEqual(2);
    expect(lockExtendedDuringHook).toBe(true);
  });

  it("does not recover a healthy sandbox after a transient heartbeat degrade", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const storage = new MemoryStorage();
    await createContext({ id: "transient", size: "16M", storage, encryption });
    const { runtimes, destroyed, provisioner } = makeProvisioner();
    const events: SessionEvent[] = [];
    let invocations = 0;

    await expect(runWithContext({
      id: "transient",
      storage,
      encryption,
      provisioner,
      lockTtlMs: 90_000,
      recovery: { enabled: true, reinvoke: true, failureThreshold: 3, emergencyCheckpoint: false },
      onSessionEvent: event => events.push(event),
    }, async session => {
      invocations += 1;
      const runtime = session.runtime as CrashableRuntime;
      // Transient control-plane hiccup: three failed beats latch degraded...
      runtime.failKeepAlive = true;
      await vi.advanceTimersByTimeAsync(95_000);
      // ...then the heartbeat recovers fully.
      runtime.failKeepAlive = false;
      await vi.advanceTimersByTimeAsync(31_000);
      // A plain user-code error afterwards must NOT destroy the healthy
      // sandbox and replay fn.
      throw new Error("user-code bug");
    })).rejects.toThrow(/user-code bug/);

    expect(invocations).toBe(1);
    expect(runtimes).toHaveLength(1);
    expect(destroyed).toEqual(["sandbox-1"]); // session-end teardown only
    expect(events.filter(event => event.type === "degraded")).toHaveLength(1);
    expect(events.some(event => event.type === "recovery-start")).toBe(false);
  });

  it("keeps renewing the lock while the replacement sandbox is provisioned", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const storage = new MemoryStorage();
    await createContext({ id: "slow-provision", size: "16M", storage, encryption });
    const runtimes: CrashableRuntime[] = [];
    let resumeProvision: (() => void) | undefined;
    const provisioner = {
      async createSessionRuntime() {
        const runtime = new CrashableRuntime(`sandbox-${runtimes.length + 1}`);
        runtimes.push(runtime);
        if (runtimes.length === 2) {
          // Re-provisioning stalls until the test releases it.
          await new Promise<void>(resolve => {
            resumeProvision = resolve;
          });
        }
        return runtime;
      },
    };

    const run = runWithContext({
      id: "slow-provision",
      storage,
      encryption,
      provisioner,
      lockTtlMs: 90_000,
      recovery: { enabled: true, onRecover: () => undefined },
    }, async session => {
      await session.runtime.kill?.();
      throw new Error("original failure");
    }).catch((error: unknown) => error);

    await until(() => resumeProvision !== undefined, "re-provision to stall");
    const before = (await readLock(storage, "slow-provision"))!.expiresAt;
    // The lock-only recovery timer must keep extending the TTL while
    // provisioning is stuck, or another writer could take over mid-recovery.
    await until(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      const lock = await readLock(storage, "slow-provision");
      return Date.parse(lock!.expiresAt) > Date.parse(before);
    }, "lock renewal during stalled provisioning");
    resumeProvision!();
    const outcome = await run;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/original failure/);
  });

  it("counts a hung keepAlive as a failed beat instead of going blind", async () => {
    // Deadlines use setTimeout, so fake it too; the until() helper is unused here.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const storage = new MemoryStorage();
    await createContext({ id: "hung-keepalive", size: "16M", storage, encryption });
    const runtime = new CrashableRuntime("sandbox-1");
    runtime.keepAlive = () => new Promise<never>(() => undefined); // hangs forever
    const events: SessionEvent[] = [];

    await runWithContext({
      id: "hung-keepalive",
      storage,
      encryption,
      runtime,
      lockTtlMs: 90_000,
      recovery: { enabled: true, failureThreshold: 3, emergencyCheckpoint: false },
      onSessionEvent: event => events.push(event),
    }, async () => {
      // Beats at 30s intervals; each hung keepAlive times out 30s later.
      await vi.advanceTimersByTimeAsync(130_000);
      expect(events.filter(event => event.type === "degraded")).toHaveLength(1);
      const failure = events.find(event => event.type === "heartbeat-failure");
      expect(failure?.error?.message).toMatch(/keep-alive .* timed out/);
    });
  });

  it("does not release an adopted lock when the re-attach fails", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "adopted", size: "16M", storage, encryption });
    await acquireLock({ storage, contextId: "adopted", runtimeId: "sandbox-1", owner: "owner-live", ttlMs: 60_000 });
    const runtime = new CrashableRuntime("sandbox-2");
    runtime.uploadFile = async () => {
      throw new Error("upload exploded");
    };

    // Same-owner re-attach (the recovery path) fails mid-attach: the live
    // session's lock must survive, unlike a fresh acquire (session.test.ts).
    await expect(attachContext({
      id: "adopted",
      storage,
      encryption,
      runtime,
      owner: "owner-live",
    })).rejects.toThrow(/upload exploded/);
    await expect(readLock(storage, "adopted")).resolves.toMatchObject({ owner: "owner-live" });
  });
});
