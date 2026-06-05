import { describe, expect, it, vi } from "vitest";
import { defaultSandboxTimeoutMs, ModalSandboxAdapter } from "../packages/adapter-modal/src/index.js";
import type { SandboxCreateParams } from "modal";

function fakeModal() {
  const terminate = vi.fn(async () => undefined);
  const sandbox = { sandboxId: "sb-modal", terminate, exec: vi.fn(), filesystem: {} };
  const created: { params?: SandboxCreateParams } = {};
  const client = {
    apps: { fromName: vi.fn(async () => ({ name: "contextsdk" })) },
    images: { fromRegistry: vi.fn(() => ({ tag: "python:3.13-slim" })) },
    volumes: { fromName: vi.fn(async () => ({ withMountOptions: vi.fn(() => ({})) })) },
    sandboxes: {
      create: vi.fn(async (_app: unknown, _image: unknown, params: SandboxCreateParams) => {
        created.params = params;
        return sandbox;
      }),
      fromId: vi.fn(async () => sandbox),
    },
  };
  return { client, sandbox, terminate, created };
}

describe("ModalSandboxAdapter", () => {
  it("defaults new sandboxes to a workload-sized lifetime instead of Modal's 5 minutes", async () => {
    const { client, created } = fakeModal();
    await ModalSandboxAdapter.create({ client: client as never });
    expect(created.params?.timeoutMs).toBe(defaultSandboxTimeoutMs);
    expect(created.params?.tags).toEqual({ contextsdk: "true" });
  });

  it("terminates only sandboxes it created", async () => {
    const { client, terminate } = fakeModal();
    const owned = await ModalSandboxAdapter.create({ client: client as never });
    await owned.dispose();
    expect(terminate).toHaveBeenCalledTimes(1);

    terminate.mockClear();
    const reattached = await ModalSandboxAdapter.create({ client: client as never, sandboxId: "sb-modal" });
    await reattached.dispose();
    expect(terminate).not.toHaveBeenCalled();

    const supplied = await ModalSandboxAdapter.create({ sandbox: fakeModal().sandbox as never });
    await supplied.dispose();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("passes the idle timeout through to sandbox creation", async () => {
    const { client, created } = fakeModal();
    await ModalSandboxAdapter.create({ client: client as never, idleTimeoutMs: 300_000 });
    expect(created.params?.idleTimeoutMs).toBe(300_000);
  });
});
