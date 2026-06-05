import { RuntimeCommandError } from "./errors.js";
import type { RuntimeCapabilities, RuntimeProvider, RuntimeStateMetadata } from "./types.js";

export interface RuntimeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeRunOptions {
  user?: string;
  timeoutMs?: number;
}

export interface RuntimeAdapter {
  id: string;
  provider?: RuntimeProvider | string;
  capabilities?: RuntimeCapabilities;
  /** Wall-clock lifetime the runtime will enforce on its sandbox, if any. The session heartbeat keeps keepAlive cadence safely below it. */
  sandboxTimeoutMs?: number;
  defaultMountPath?(contextId: string): string;
  run(command: string, options?: RuntimeRunOptions): Promise<RuntimeCommandResult>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  flush?(mountPath: string): Promise<void>;
  getRuntimeState?(): Promise<RuntimeStateMetadata | undefined>;
  finalizeRuntimeState?(): Promise<RuntimeStateMetadata | undefined>;
  /**
   * Called periodically while a session is active. Adapters whose sandboxes
   * auto-terminate on a countdown (E2B, Vercel) reset it here so the sandbox
   * lives exactly as long as the session plus its configured timeout.
   */
  keepAlive?(): Promise<void>;
  dispose?(): Promise<void>;
}

export function assertSuccess(result: RuntimeCommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new RuntimeCommandError(label, result);
  }
}
