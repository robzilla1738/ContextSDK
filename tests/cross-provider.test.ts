import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext, readManifest, runWithContext } from "../src/context.js";
import { MemoryStorage } from "../src/storage.js";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "../src/runtime.js";
import type { RuntimeCapabilities } from "../src/types.js";

const encryption = { passphrase: "cross-provider", scrypt: { cost: 1024, blockSize: 8, parallelization: 1 } };
const toolsAvailable = ["bash", "tar", "zstd", "python3"].every(hasCommand);

/**
 * Executes the SDK's real pack/unpack/snapshot scripts locally, so the
 * cross-provider data path runs end-to-end: bash + python validation +
 * tar/zstd, exactly as it does inside a provider sandbox.
 */
class LocalExecRuntime implements RuntimeAdapter {
  readonly id: string;
  constructor(
    readonly machineRoot: string,
    readonly capabilities: RuntimeCapabilities,
    name: string,
  ) {
    this.id = `local:${name}`;
  }

  defaultMountPath(contextId: string): string {
    return join(this.machineRoot, "mount", contextId);
  }

  run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
      child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", code => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
      });
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await mkdir(dirname(remotePath), { recursive: true });
    await copyFile(localPath, remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await copyFile(remotePath, localPath);
  }
}

describe("cross-provider portability", () => {
  it.runIf(toolsAvailable)(
    "moves a tree context between providers through the real pack/unpack scripts",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "contextsdk-cross-"));
      try {
        const storage = new MemoryStorage();
        const id = "hop-test";
        await createContext({ id, storage, encryption });

        // "Provider A" advertises loop-ext4 support like E2B; tree contexts must
        // still take the directory-bundle path on it.
        const providerA = new LocalExecRuntime(join(dir, "provider-a"), { directoryBundle: true, loopExt4: true }, "a");
        await runWithContext({ id, storage, encryption, runtime: providerA }, async session => {
          expect(session.mounted.mode).toBe("directoryBundle");
          await session.files.write("workspace/hop.txt", "written on provider A\n");
          // Simulate runtime state the portable bundle must exclude but the
          // provider mount must keep: dependency dirs and the cache root.
          await mkdir(join(session.mountPath, "workspace", "node_modules", "dep"), { recursive: true });
          await mkdir(join(session.mountPath, "cache"), { recursive: true });
          await readFile(join(session.mountPath, "workspace", "hop.txt"), "utf8");
          await session.runtime.run(`echo dep > ${join(session.mountPath, "workspace", "node_modules", "dep", "index.js")}`);
          await session.runtime.run(`echo cached > ${join(session.mountPath, "cache", "build.bin")}`);
        });

        const manifest = await readManifest(storage, id);
        expect(manifest.format).toBe("tree");
        expect(manifest.generation).toBe(2);

        // "Provider B" is a different machine root entirely (Vercel/Modal-like).
        const providerB = new LocalExecRuntime(join(dir, "provider-b"), { directoryBundle: true, loopExt4: false }, "b");
        await runWithContext({ id, storage, encryption, runtime: providerB }, async session => {
          const hop = await session.files.read("workspace/hop.txt");
          expect(hop.toString()).toBe("written on provider A\n");
          // Dependency dirs stayed out of the portable bundle.
          await expect(readFile(join(session.mountPath, "workspace", "node_modules", "dep", "index.js"))).rejects.toThrow();
          await session.files.append("workspace/hop.txt", "read on provider B");
        });

        // Re-attach on provider A: portable state was updated by B, while A's
        // provider-local runtime state (cache and dependency dirs) survived.
        await runWithContext({ id, storage, encryption, runtime: providerA }, async session => {
          const hop = await session.files.read("workspace/hop.txt");
          expect(hop.toString()).toContain("read on provider B");
          await expect(readFile(join(session.mountPath, "cache", "build.bin"), "utf8")).resolves.toBe("cached\n");
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

function hasCommand(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
