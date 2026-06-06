import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";
import { sanitizeId } from "@contextsdk/core";
import type {
  RuntimeAdapter,
  RuntimeCommandResult,
  RuntimeProvisionOptions,
  RuntimeRunOptions,
  RuntimeStateMetadata,
} from "@contextsdk/core";

const DEFAULT_SNAPSHOT_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_KEEP_LAST_SNAPSHOTS = 3;

/**
 * Vercel stops sandboxes 5 minutes after creation unless a timeout is set — far too
 * short for agent sessions. 45 minutes stays within every plan's limit, and the
 * keepAlive heartbeat extends it while a session is actively running.
 */
export const defaultSandboxTimeoutMs = 45 * 60_000;

export interface VercelAdapterOptions {
  sandbox?: Sandbox;
  sandboxName?: string;
  contextId?: string;
  runtime?: "node24" | "node22" | "node26" | "python3.13" | string;
  timeoutMs?: number;
  vcpus?: number;
  env?: Record<string, string>;
  persistent?: boolean;
  snapshotExpirationMs?: number;
  keepLastSnapshots?: number;
  /**
   * Vercel API token, with teamId and projectId, for headless use. Without these the
   * SDK falls back to the VERCEL_OIDC_TOKEN environment variable (`vercel link` +
   * `vercel env pull`) or an interactive login prompt.
   */
  token?: string;
  teamId?: string;
  projectId?: string;
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
  readonly sandboxTimeoutMs: number;
  private stopped = false;
  private lastRuntimeState?: RuntimeStateMetadata;
  // Tracks the deadline we have driven the sandbox toward. extendTimeout adds to
  // the current deadline, so keepAlive extends by only the delta back to
  // now+timeoutMs each beat instead of pushing the deadline toward the plan cap.
  private intendedDeadline: number;

  private constructor(
    private readonly sandbox: Sandbox,
    private readonly options: { persistent: boolean; timeoutMs: number; now: number },
  ) {
    this.id = `vercel:${sandbox.name}`;
    this.sandboxTimeoutMs = options.timeoutMs;
    this.intendedDeadline = options.now + options.timeoutMs;
  }

  static async create(options: VercelAdapterOptions = {}): Promise<VercelSandboxAdapter> {
    const persistent = options.persistent ?? true;
    const timeoutMs = options.timeoutMs ?? defaultSandboxTimeoutMs;
    const sandboxName = options.sandboxName ?? (options.contextId ? defaultVercelSandboxName(options.contextId) : undefined);
    const sandbox = options.sandbox
      ?? await createVercelSandbox({
        ...options,
        sandboxName,
        persistent,
      });
    return new VercelSandboxAdapter(sandbox, { persistent, timeoutMs, now: Date.now() });
  }

  defaultMountPath(contextId: string): string {
    return `/vercel/sandbox/contextsdk/${sanitizeId(contextId)}`;
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    // Vercel sandboxes expose exactly two identities: the default vercel-sandbox
    // user and root via sudo. Anything else must fail loudly, not run as the
    // wrong user.
    if (options.user !== undefined && options.user !== "root" && options.user !== "vercel-sandbox") {
      throw new Error(`Vercel runtime only supports user "root" or "vercel-sandbox", got: ${options.user}`);
    }
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

  async keepAlive(): Promise<void> {
    if (this.stopped) {
      return;
    }
    // extendTimeout adds to the current deadline. Extend by only the time elapsed
    // since the last beat so the deadline tracks now+timeoutMs, never racing the
    // plan's maximum execution timeout.
    const target = Date.now() + this.options.timeoutMs;
    const delta = target - this.intendedDeadline;
    if (delta > 0) {
      await this.sandbox.extendTimeout(delta);
      this.intendedDeadline = target;
    }
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

  async getRuntimeState(): Promise<RuntimeStateMetadata | undefined> {
    this.lastRuntimeState = runtimeStateFromSandbox(this.sandbox, this.options.persistent);
    return this.lastRuntimeState;
  }

  async finalizeRuntimeState(): Promise<RuntimeStateMetadata | undefined> {
    if (!this.options.persistent) {
      await this.dispose();
      this.lastRuntimeState = runtimeStateFromSandbox(this.sandbox, false);
      return this.lastRuntimeState;
    }
    if (!this.stopped) {
      const stopped = await this.sandbox.stop();
      this.stopped = true;
      this.lastRuntimeState = {
        ...runtimeStateFromSandbox(this.sandbox, true),
        currentSnapshotId: stopped.snapshot?.id ?? this.sandbox.currentSnapshotId,
        sourceSnapshotId: stopped.sourceSnapshotId ?? this.sandbox.sourceSnapshotId,
        updatedAt: new Date().toISOString(),
      };
      return this.lastRuntimeState;
    }
    return this.lastRuntimeState ?? runtimeStateFromSandbox(this.sandbox, true);
  }

  async dispose(): Promise<void> {
    if (!this.stopped) {
      await this.sandbox.stop();
      this.stopped = true;
    }
  }

  /** Stops the sandbox unconditionally — crash simulation / forced teardown. Vercel has no harder kill than stop. */
  async kill(): Promise<void> {
    await this.dispose();
  }
}

export class VercelProvisioner {
  constructor(private readonly options: VercelAdapterOptions = {}) {}

  async createSessionRuntime(options: RuntimeProvisionOptions & VercelAdapterOptions = {}): Promise<RuntimeAdapter> {
    return VercelSandboxAdapter.create({ ...this.options, ...options });
  }

  async destroyRuntime(runtime: RuntimeAdapter): Promise<void> {
    await runtime.dispose?.();
  }
}

export function defaultVercelSandboxName(contextId: string): string {
  return `contextsdk-${sanitizeId(contextId)}`;
}

export function buildVercelCreateOptionsForTest(options: VercelAdapterOptions = {}): Record<string, unknown> {
  const persistent = options.persistent ?? true;
  const keepLastSnapshots = options.keepLastSnapshots ?? DEFAULT_KEEP_LAST_SNAPSHOTS;
  const snapshotExpiration = options.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS;
  return {
    name: options.sandboxName ?? (options.contextId ? defaultVercelSandboxName(options.contextId) : undefined),
    runtime: options.runtime ?? "python3.13",
    timeout: options.timeoutMs ?? defaultSandboxTimeoutMs,
    resources: options.vcpus ? { vcpus: options.vcpus } : undefined,
    env: options.env,
    persistent,
    snapshotExpiration: persistent ? snapshotExpiration : undefined,
    keepLastSnapshots: persistent ? { count: keepLastSnapshots, expiration: snapshotExpiration } : undefined,
    tags: { contextsdk: "true" },
    ...credentialsFrom(options),
  };
}

function credentialsFrom(options: VercelAdapterOptions): { token: string; teamId: string; projectId: string } | Record<string, never> {
  // The SDK requires all three together; partial credentials would make it throw
  // before falling back to OIDC, so only forward a complete set.
  if (options.token && options.teamId && options.projectId) {
    return { token: options.token, teamId: options.teamId, projectId: options.projectId };
  }
  return {};
}

async function createVercelSandbox(options: VercelAdapterOptions & { persistent: boolean }): Promise<Sandbox> {
  const createOptions = buildVercelCreateOptionsForTest(options);
  if (options.persistent && options.sandboxName && typeof Sandbox.getOrCreate === "function") {
    return Sandbox.getOrCreate(createOptions as never);
  }
  if (options.persistent && options.sandboxName) {
    try {
      return await Sandbox.get({ name: options.sandboxName, ...credentialsFrom(options) } as never);
    } catch {
      return Sandbox.create(createOptions as never);
    }
  }
  return Sandbox.create(createOptions as never);
}

function runtimeStateFromSandbox(sandbox: Sandbox, persistent: boolean): RuntimeStateMetadata {
  return {
    provider: "vercel",
    mode: persistent ? "provider-persistence" : "disabled",
    sandboxName: sandbox.name,
    persistent,
    currentSnapshotId: sandbox.currentSnapshotId,
    sourceSnapshotId: sandbox.sourceSnapshotId,
    updatedAt: new Date().toISOString(),
    details: {
      runtime: sandbox.runtime,
      region: sandbox.region,
      vcpus: sandbox.vcpus,
      memory: sandbox.memory,
      snapshotExpiration: sandbox.snapshotExpiration,
      keepLastSnapshots: sandbox.keepLastSnapshots,
    },
  };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
