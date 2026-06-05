import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExitError } from "e2b";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSandboxTimeoutMs, E2BAdapter } from "../packages/adapter-e2b/src/e2b-adapter.js";

function fakeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    sandboxId: "sb-fake",
    uploadUrl: vi.fn(async () => "https://49983-sb-fake.e2b.app/upload"),
    downloadUrl: vi.fn(async () => "https://49983-sb-fake.e2b.app/download"),
    setTimeout: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    commands: { run: vi.fn() },
    ...overrides,
  };
}

async function adapterWith(sandbox: ReturnType<typeof fakeSandbox>, timeoutMs?: number) {
  return E2BAdapter.create({ sandbox: sandbox as never, timeoutMs });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("E2BAdapter", () => {
  it("retries transfer fetches through transient network failures", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-e2b-"));
    const local = join(dir, "payload");
    await writeFile(local, "bundle bytes");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { code: "UND_ERR_CONNECT_TIMEOUT" }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = await adapterWith(fakeSandbox());
    const upload = adapter.uploadFile(local, "/tmp/remote");
    await vi.advanceTimersByTimeAsync(15_000);
    await upload;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on a definitive 4xx response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-e2b-"));
    const local = join(dir, "payload");
    await writeFile(local, "bundle bytes");
    const fetchMock = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = await adapterWith(fakeSandbox());
    await expect(adapter.uploadFile(local, "/tmp/remote")).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams downloads to disk with private permissions after retrying", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-e2b-"));
    const local = join(dir, "downloaded");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response("encrypted-bundle", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = await adapterWith(fakeSandbox());
    const download = adapter.downloadFile("/tmp/remote", local);
    await vi.advanceTimersByTimeAsync(15_000);
    await download;
    await expect(readFile(local, "utf8")).resolves.toBe("encrypted-bundle");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps command exit errors to results but rethrows infrastructure failures", async () => {
    const sandbox = fakeSandbox();
    sandbox.commands.run = vi.fn()
      .mockRejectedValueOnce(new CommandExitError({ exitCode: 7, error: "", stdout: "out", stderr: "err" } as never))
      .mockRejectedValueOnce(new Error("2: [unknown] fetch failed"));
    const adapter = await adapterWith(sandbox);

    await expect(adapter.run("false")).resolves.toMatchObject({ exitCode: 7, stdout: "out", stderr: "err" });
    await expect(adapter.run("true")).rejects.toThrow(/fetch failed/);
  });

  it("keeps the sandbox alive by resetting its timeout to the configured lifetime", async () => {
    const sandbox = fakeSandbox();
    const adapter = await adapterWith(sandbox);
    await adapter.keepAlive();
    expect(sandbox.setTimeout).toHaveBeenCalledWith(defaultSandboxTimeoutMs);

    const custom = fakeSandbox();
    const customAdapter = await adapterWith(custom, 120_000);
    await customAdapter.keepAlive();
    expect(custom.setTimeout).toHaveBeenCalledWith(120_000);
  });

  it("only kills sandboxes it created, never caller-supplied ones", async () => {
    const supplied = fakeSandbox();
    await (await adapterWith(supplied)).dispose();
    expect(supplied.kill).not.toHaveBeenCalled();
  });

  it("rejects unsupported users instead of passing arbitrary strings to the SDK", async () => {
    const sandbox = fakeSandbox();
    sandbox.commands.run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const adapter = await adapterWith(sandbox);
    await expect(adapter.run("id", { user: "postgres" })).rejects.toThrow(/only supports user/);
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("runs wrapped commands with the per-command timeout disabled so long work is not killed at 60s", async () => {
    const sandbox = fakeSandbox();
    sandbox.commands.run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const adapter = await adapterWith(sandbox);
    await adapter.run("npm install");
    expect(sandbox.commands.run).toHaveBeenCalledWith("npm install", expect.objectContaining({ timeoutMs: 0 }));
  });
});
