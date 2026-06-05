import { describe, expect, it } from "vitest";
import {
  buildVercelCreateOptionsForTest,
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
