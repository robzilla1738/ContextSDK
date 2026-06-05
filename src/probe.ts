import { assertSuccess } from "./runtime.js";
import type { RuntimeAdapter } from "./runtime.js";
import type { RuntimeProbeResult } from "./types.js";

export async function probeRuntime(options: { runtime: RuntimeAdapter }): Promise<RuntimeProbeResult> {
  const runtime = options.runtime;
  const capabilities = runtime.capabilities ?? {};
  const tools = new Set(["tar", "zstd", "python3", "sha256sum", "mkdir", "sync"]);
  if (capabilities.loopExt4) {
    for (const tool of ["losetup", "mount", "umount", "e2fsck", "findmnt"]) {
      tools.add(tool);
    }
  }

  const script = [
    "set -Eeuo pipefail",
    `for cmd in ${[...tools].map(tool => JSON.stringify(tool)).join(" ")}; do`,
    "  if ! command -v \"$cmd\" >/dev/null 2>&1; then printf '%s\\n' \"$cmd\"; fi",
    "done",
  ].join("\n");
  const result = await runtime.run(script, { user: "root" });
  assertSuccess(result, "probe runtime");
  const missingTools = result.stdout.split("\n").map(line => line.trim()).filter(Boolean);

  return {
    provider: runtime.provider ?? "unknown",
    runtimeId: runtime.id,
    capabilities,
    missingTools,
    ok: missingTools.length === 0,
    details: {
      checkedTools: [...tools],
    },
  };
}
