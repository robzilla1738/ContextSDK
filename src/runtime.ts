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
  defaultMountPath?(contextId: string): string;
  run(command: string, options?: RuntimeRunOptions): Promise<RuntimeCommandResult>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  flush?(mountPath: string): Promise<void>;
  getRuntimeState?(): Promise<RuntimeStateMetadata | undefined>;
  finalizeRuntimeState?(): Promise<RuntimeStateMetadata | undefined>;
  dispose?(): Promise<void>;
}

export function assertSuccess(result: RuntimeCommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim());
  }
}
