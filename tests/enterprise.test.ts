import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/context.js";
import {
  DefaultEnterprisePolicy,
  EnterpriseContextBroker,
  InMemoryAuditSink,
  StaticQuotaManager,
  StorageAuditSink,
} from "../src/enterprise.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";
import { MemoryStorage } from "../src/storage.js";

const actor = {
  id: "employee-1",
  tenantId: "acme",
  email: "employee-1@example.com",
  department: "engineering",
  roles: ["employee"],
};

class FakeRuntime implements RuntimeAdapter {
  id = "fake-runtime";
  disposed = false;
  commands: string[] = [];
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
          author: "employee-1",
          message: "enterprise run",
          changedPaths: [],
          files: [],
        })}\n`,
        stderr: "",
      };
    }
    if (command.includes("CONTEXTSDK_MOUNT_JSON")) {
      return {
        exitCode: 0,
        stdout: 'CONTEXTSDK_MOUNT_JSON={"loopDevice":"/dev/loop0","mountPath":"/mnt/contextsdk/ctx","remoteImagePath":"/tmp/contextsdk-ctx.ext4.img"}\n',
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

describe("enterprise policy", () => {
  it("denies another user's personal context", async () => {
    const policy = new DefaultEnterprisePolicy();
    await expect(policy.authorize({
      actor,
      contextId: "ctx",
      action: "context.read",
      scope: { type: "personal", ownerId: "employee-2" },
      classification: "internal",
    })).resolves.toMatchObject({ allow: false });
  });

  it("requires restricted-context role for restricted contexts", async () => {
    const policy = new DefaultEnterprisePolicy();
    await expect(policy.authorize({
      actor,
      contextId: "ctx",
      action: "context.run",
      scope: { type: "project", projectId: "proj-1" },
      classification: "restricted",
    })).resolves.toMatchObject({ allow: false });
  });
});

describe("enterprise broker", () => {
  it("can persist audit events to object storage", async () => {
    const storage = new MemoryStorage();
    const sink = new StorageAuditSink(storage);
    await sink.write({
      id: "event-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      tenantId: "acme",
      actorId: "employee-1",
      contextId: "ctx",
      action: "context.run",
      outcome: "success",
      classification: "internal",
      scope: { type: "personal", ownerId: "employee-1" },
    });
    await expect(storage.headObject("audit/tenants/acme/contexts/ctx/2026-01-01T00-00-00-000Z-event-1.json")).resolves.not.toBeNull();
  });

  it("enforces quotas and writes audit events", async () => {
    const audit = new InMemoryAuditSink();
    const broker = new EnterpriseContextBroker({
      storage: new MemoryStorage(),
      encryption: { passphrase: "passphrase" },
      audit,
      quota: new StaticQuotaManager({ maxContextSizeBytes: 1024 }),
    });

    await expect(broker.create({
      actor,
      contextId: "oversized",
      size: "16M",
      requestedSizeBytes: 16 * 1024 * 1024,
    })).rejects.toThrow(/quota denied/);

    expect(audit.events.some(event => event.outcome === "deny" && event.reason?.includes("exceeds"))).toBe(true);
  });

  it("derives requested size for quota checks", async () => {
    const audit = new InMemoryAuditSink();
    const broker = new EnterpriseContextBroker({
      storage: new MemoryStorage(),
      encryption: { passphrase: "passphrase" },
      audit,
      quota: new StaticQuotaManager({ maxContextSizeBytes: 1024 }),
    });

    await expect(broker.create({
      actor,
      contextId: "oversized-derived",
      size: "16M",
    })).rejects.toThrow(/quota denied/);

    expect(audit.events.some(event => event.outcome === "deny" && event.reason?.includes("exceeds"))).toBe(true);
  });

  it("audits missing provisioners as runtime failures", async () => {
    const audit = new InMemoryAuditSink();
    const broker = new EnterpriseContextBroker({
      storage: new MemoryStorage(),
      encryption: { passphrase: "passphrase" },
      audit,
    });

    await expect(broker.run({
      actor,
      contextId: "ctx",
      runtime: "e2b",
    }, async () => undefined)).rejects.toThrow(/no provisioner registered/);

    expect(audit.events.some(event => (
      event.action === "context.run"
      && event.outcome === "failure"
      && event.reason?.includes("no provisioner registered")
    ))).toBe(true);
  });

  it("runs through provisioned context sessions with audit", async () => {
    const storage = new MemoryStorage();
    const audit = new InMemoryAuditSink();
    const runtime = new FakeRuntime();
    await createContext({ id: "ctx", size: "16M", storage, encryption: { passphrase: "passphrase" } });

    const broker = new EnterpriseContextBroker({
      storage,
      encryption: { passphrase: "passphrase" },
      audit,
      provisioners: {
        e2b: {
          async createSessionRuntime() {
            return runtime;
          },
          async destroyRuntime(createdRuntime) {
            await createdRuntime.dispose?.();
          },
        },
      },
    });

    await broker.run({
      actor,
      contextId: "ctx",
      runtime: "e2b",
      message: "enterprise run",
    }, async session => {
      expect(session.id).toBe("ctx");
    });

    expect(runtime.disposed).toBe(true);
    expect(audit.events.some(event => event.action === "context.run" && event.outcome === "success")).toBe(true);
  });

  it("records an audit failure when the policy engine throws", async () => {
    const storage = new MemoryStorage();
    const audit = new InMemoryAuditSink();
    const broker = new EnterpriseContextBroker({
      storage,
      encryption: { passphrase: "passphrase" },
      audit,
      policy: {
        async authorize() {
          throw new Error("policy backend unreachable");
        },
      },
    });

    await expect(broker.create({ actor, contextId: "ctx-policy-crash", size: "16M" }))
      .rejects.toThrow(/policy backend unreachable/);
    expect(audit.events.some(event =>
      event.action === "context.create"
      && event.outcome === "failure"
      && event.reason?.includes("policy engine error"),
    )).toBe(true);
  });

  it("records an audit failure when the quota manager throws", async () => {
    const storage = new MemoryStorage();
    const audit = new InMemoryAuditSink();
    const broker = new EnterpriseContextBroker({
      storage,
      encryption: { passphrase: "passphrase" },
      audit,
      quota: {
        async check() {
          throw new Error("quota backend unreachable");
        },
      },
    });

    await expect(broker.create({ actor, contextId: "ctx-quota-crash", size: "16M" }))
      .rejects.toThrow(/quota backend unreachable/);
    expect(audit.events.some(event =>
      event.action === "context.create"
      && event.outcome === "failure"
      && event.reason?.includes("quota manager error"),
    )).toBe(true);
  });
});
