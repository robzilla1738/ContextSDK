import { describe, expect, it, vi } from "vitest";
import {
  buildVercelCreateOptionsForTest,
  defaultSandboxTimeoutMs,
  defaultVercelSandboxName,
  VercelSandboxAdapter,
} from "../packages/adapter-vercel/src/index.js";

describe("Vercel adapter runtime state", () => {
  it("derives stable persistent sandbox names from context ids", () => {
    expect(defaultVercelSandboxName("employee/Robert Context")).toBe("contextsdk-employee-Robert-Context");
  });

  it("defaults Vercel sandboxes to persistent provider state with retention", () => {
    expect(buildVercelCreateOptionsForTest({ contextId: "demo" })).toMatchObject({
      name: "contextsdk-demo",
      runtime: "python3.13",
      persistent: true,
      snapshotExpiration: 14 * 24 * 60 * 60 * 1000,
      keepLastSnapshots: {
        count: 3,
        expiration: 14 * 24 * 60 * 60 * 1000,
      },
    });
  });

  it("honors ephemeral Vercel runtime state", () => {
    expect(buildVercelCreateOptionsForTest({
      contextId: "demo",
      persistent: false,
      snapshotExpirationMs: 1000,
      keepLastSnapshots: 9,
    })).toMatchObject({
      name: "contextsdk-demo",
      persistent: false,
      snapshotExpiration: undefined,
      keepLastSnapshots: undefined,
    });
  });

  it("defaults the sandbox timeout to the session-sized lifetime, not Vercel's 5 minutes", () => {
    expect(buildVercelCreateOptionsForTest({ contextId: "demo" })).toMatchObject({
      timeout: defaultSandboxTimeoutMs,
    });
    expect(buildVercelCreateOptionsForTest({ contextId: "demo", timeoutMs: 120_000 })).toMatchObject({
      timeout: 120_000,
    });
  });

  it("forwards credentials only as a complete token/team/project triple", () => {
    expect(buildVercelCreateOptionsForTest({ contextId: "demo", token: "tok" })).not.toHaveProperty("token");
    expect(buildVercelCreateOptionsForTest({
      contextId: "demo",
      token: "tok",
      teamId: "team",
      projectId: "proj",
    })).toMatchObject({ token: "tok", teamId: "team", projectId: "proj" });
  });

  it("rejects unsupported users instead of silently running as the default user", async () => {
    const runCommand = vi.fn();
    const adapter = await VercelSandboxAdapter.create({ sandbox: { name: "s", runCommand } as never });
    await expect(adapter.run("id", { user: "postgres" })).rejects.toThrow(/only supports user/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("keeps the sandbox alive by extending the timeout by the elapsed delta, not racing the plan cap", async () => {
    vi.useFakeTimers();
    try {
      const extendTimeout = vi.fn((_duration: number) => Promise.resolve());
      const adapter = await VercelSandboxAdapter.create({ sandbox: { name: "s", extendTimeout } as never, timeoutMs: 90_000 });
      // 10 minutes pass between beats; the extension should be ~that delta, never
      // the full 90s-per-beat that would race the plan's max execution timeout.
      vi.advanceTimersByTime(10 * 60_000);
      await adapter.keepAlive();
      expect(extendTimeout).toHaveBeenCalledTimes(1);
      expect(extendTimeout).toHaveBeenCalledWith(10 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports runtime state metadata from the sandbox", async () => {
    const adapter = await VercelSandboxAdapter.create({
      persistent: true,
      sandbox: {
        name: "contextsdk-demo",
        currentSnapshotId: "snap-current",
        sourceSnapshotId: "snap-source",
        runtime: "python3.13",
        region: "iad1",
        vcpus: 2,
        memory: 4096,
        snapshotExpiration: 1000,
        keepLastSnapshots: { count: 3 },
      } as never,
    });

    await expect(adapter.getRuntimeState()).resolves.toMatchObject({
      provider: "vercel",
      mode: "provider-persistence",
      sandboxName: "contextsdk-demo",
      persistent: true,
      currentSnapshotId: "snap-current",
      sourceSnapshotId: "snap-source",
      details: {
        runtime: "python3.13",
        region: "iad1",
        vcpus: 2,
      },
    });
  });
});
