import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { ModalClient, type ModalClientParams, type Sandbox, type SandboxCreateParams } from "modal";
import { sanitizeId } from "@contextsdk/core";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "@contextsdk/core";

export interface ModalAdapterOptions {
  sandbox?: Sandbox;
  sandboxId?: string;
  client?: ModalClient;
  clientOptions?: ModalClientParams;
  appName?: string;
  imageTag?: string;
  volumeName?: string;
  volumeMountPath?: string;
  volumeSubPath?: string;
  timeoutMs?: number;
  cpu?: number;
  memoryMiB?: number;
  env?: Record<string, string>;
}

export class ModalSandboxAdapter implements RuntimeAdapter {
  readonly provider = "modal";
  readonly capabilities = {
    loopExt4: false,
    directoryBundle: true,
    providerVolume: true,
    providerSnapshot: false,
  };
  readonly id: string;
  private readonly volumeMountPath: string;

  private constructor(
    private readonly sandbox: Sandbox,
    options: { volumeMountPath: string },
  ) {
    this.id = `modal:${sandbox.sandboxId}`;
    this.volumeMountPath = options.volumeMountPath;
  }

  static async create(options: ModalAdapterOptions = {}): Promise<ModalSandboxAdapter> {
    const client = options.client ?? new ModalClient(options.clientOptions);
    const volumeMountPath = options.volumeMountPath ?? "/contextsdk";
    const sandbox = options.sandbox
      ?? (options.sandboxId
        ? await client.sandboxes.fromId(options.sandboxId)
        : await createSandbox(client, volumeMountPath, options));
    return new ModalSandboxAdapter(sandbox, { volumeMountPath });
  }

  defaultMountPath(contextId: string): string {
    return `${this.volumeMountPath.replace(/\/+$/g, "")}/${sanitizeId(contextId)}`;
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    const process = await this.sandbox.exec(["bash", "-lc", command], {
      timeoutMs: options.timeoutMs,
      workdir: this.volumeMountPath,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.wait(),
      process.stdout.readText(),
      process.stderr.readText(),
    ]);
    return { exitCode, stdout, stderr };
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.run(`mkdir -p ${quote(dirname(remotePath))}`);
    await this.sandbox.filesystem.writeBytes(await readFile(localPath), remotePath);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.filesystem.copyToLocal(remotePath, localPath);
  }

  async flush(mountPath: string): Promise<void> {
    await this.run(`sync ${quote(mountPath)} 2>/dev/null || sync`);
  }

  async dispose(): Promise<void> {
    await this.sandbox.terminate();
  }
}

export class ModalProvisioner {
  constructor(private readonly options: ModalAdapterOptions = {}) {}

  async createSessionRuntime(options: ModalAdapterOptions = {}): Promise<RuntimeAdapter> {
    return ModalSandboxAdapter.create({ ...this.options, ...options });
  }

  async destroyRuntime(runtime: RuntimeAdapter): Promise<void> {
    await runtime.dispose?.();
  }
}

async function createSandbox(client: ModalClient, volumeMountPath: string, options: ModalAdapterOptions): Promise<Sandbox> {
  const app = await client.apps.fromName(options.appName ?? "contextsdk", { createIfMissing: true });
  const image = client.images.fromRegistry(options.imageTag ?? "python:3.13-slim");
  const volume = await client.volumes.fromName(options.volumeName ?? "contextsdk-contexts", { createIfMissing: true });
  const mountedVolume = options.volumeSubPath ? volume.withMountOptions({ subPath: options.volumeSubPath }) : volume;
  const params: SandboxCreateParams = {
    volumes: { [volumeMountPath]: mountedVolume },
    workdir: volumeMountPath,
    timeoutMs: options.timeoutMs,
    cpu: options.cpu,
    memoryMiB: options.memoryMiB,
    env: options.env,
    tags: { contextsdk: "true" },
  };
  return client.sandboxes.create(app, image, params);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
