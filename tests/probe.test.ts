import { describe, expect, it } from "vitest";
import { probeRuntime } from "../src/probe.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";

class ProbeRuntime implements RuntimeAdapter {
  id = "probe-runtime";
  provider = "vercel";
  capabilities = { directoryBundle: true, providerSnapshot: true };
  command = "";

  async run(command: string): Promise<RuntimeCommandResult> {
    this.command = command;
    return { exitCode: 0, stdout: "zstd\n", stderr: "" };
  }

  async uploadFile(): Promise<void> {}

  async downloadFile(): Promise<void> {}
}

describe("runtime probing", () => {
  it("reports provider capabilities and missing tools", async () => {
    const runtime = new ProbeRuntime();
    const probe = await probeRuntime({ runtime });

    expect(probe.provider).toBe("vercel");
    expect(probe.capabilities.directoryBundle).toBe(true);
    expect(probe.missingTools).toEqual(["zstd"]);
    expect(probe.ok).toBe(false);
    expect(runtime.command).toContain("tar");
    expect(runtime.command).not.toContain("losetup");
  });
});
