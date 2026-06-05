import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";
import { sanitizeId } from "@contextsdk/core";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "@contextsdk/core";

export interface VercelAdapterOptions {
  sandbox?: Sandbox;
  sandboxName?: string;
  runtime?: "node24" | "node22" | "node26" | "python3.13" | string;
  timeoutMs?: number;
  vcpus?: number;
  env?: Record<string, string>;
}

export class VercelSandboxAdapter implements RuntimeAdapter {
  readonly provider = "vercel";
  readonly capabilities = {
    loopExt4: false,
    directoryBundle: true,
    providerVolume: false,
    providerSnapshot: true,
  };
  readonly id: string;

  private constructor(private readonly sandbox: Sandbox) {
    this.id = `vercel:${sandbox.name}`;
  }

  static async create(options: VercelAdapterOptions = {}): Promise<VercelSandboxAdapter> {
    const sandbox = options.sandbox
      ?? (options.sandboxName
        ? await Sandbox.get({ name: options.sandboxName })
        : await Sandbox.create({
            name: options.sandboxName,
            runtime: options.runtime ?? "python3.13",
            timeout: options.timeoutMs,
            resources: options.vcpus ? { vcpus: options.vcpus } : undefined,
            env: options.env,
            tags: { contextsdk: "true" },
          }));
    return new VercelSandboxAdapter(sandbox);
  }

  defaultMountPath(contextId: string): string {
    return `/vercel/sandbox/contextsdk/${sanitizeId(contextId)}`;
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    const result = await this.sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", command],
      sudo: options.user === "root",
      timeoutMs: options.timeoutMs,
    });
    return {
      exitCode: result.exitCode,
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.sandbox.runCommand({ cmd: "mkdir", args: ["-p", dirname(remotePath)], sudo: true });
    await this.sandbox.writeFiles([{ path: remotePath, content: await readFile(localPath), mode: 0o600 }]);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const written = await this.sandbox.downloadFile(
      { path: remotePath },
      { path: localPath },
      { mkdirRecursive: true },
    );
    if (!written) {
      throw new Error(`Vercel sandbox file not found: ${remotePath}`);
    }
  }

  async flush(mountPath: string): Promise<void> {
    await this.run(`sync ${quote(mountPath)} 2>/dev/null || sync`, { user: "root" });
  }

  async dispose(): Promise<void> {
    await this.sandbox.stop();
  }
}

export class VercelProvisioner {
  constructor(private readonly options: VercelAdapterOptions = {}) {}

  async createSessionRuntime(options: VercelAdapterOptions = {}): Promise<RuntimeAdapter> {
    return VercelSandboxAdapter.create({ ...this.options, ...options });
  }

  async destroyRuntime(runtime: RuntimeAdapter): Promise<void> {
    await runtime.dispose?.();
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
