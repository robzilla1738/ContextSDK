import { basename } from "node:path";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CommandExitError, Sandbox, type Username } from "e2b";
import { defaultMountPath } from "@contextsdk/core";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "@contextsdk/core";

/**
 * E2B kills sandboxes 5 minutes after creation by default — far too short for agent
 * sessions. 30 minutes plus the keepAlive heartbeat (which resets the countdown while
 * a session is active) keeps sandboxes alive exactly as long as they are being used.
 */
export const defaultSandboxTimeoutMs = 30 * 60_000;

/** Transfer retry schedule. Fresh sandboxes intermittently need a few seconds before their ingress resolves. */
const transferRetryDelaysMs = [1_000, 3_000, 6_000];

export interface E2BAdapterOptions {
  sandbox?: Sandbox;
  sandboxId?: string;
  template?: string;
  timeoutMs?: number;
  apiKey?: string;
  secure?: boolean;
}

export class E2BAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly provider = "e2b";
  readonly capabilities = {
    loopExt4: true,
    directoryBundle: true,
    providerVolume: false,
    providerSnapshot: false,
  };
  readonly sandboxTimeoutMs: number;
  private readonly sandbox: Sandbox;
  private readonly timeoutMs: number;
  private readonly ownsSandbox: boolean;

  private constructor(sandbox: Sandbox, timeoutMs: number, ownsSandbox: boolean) {
    this.sandbox = sandbox;
    this.timeoutMs = timeoutMs;
    this.sandboxTimeoutMs = timeoutMs;
    this.ownsSandbox = ownsSandbox;
    this.id = `e2b:${sandbox.sandboxId}`;
  }

  defaultMountPath(contextId: string): string {
    return defaultMountPath(contextId);
  }

  static async create(options: E2BAdapterOptions = {}): Promise<E2BAdapter> {
    const timeoutMs = options.timeoutMs ?? defaultSandboxTimeoutMs;
    // A caller-supplied or reattached sandbox belongs to the caller's lifecycle;
    // only a sandbox we created may be killed on dispose.
    const ownsSandbox = !options.sandbox && !options.sandboxId;
    if (options.sandbox) {
      return new E2BAdapter(options.sandbox, timeoutMs, ownsSandbox);
    }
    const sandbox = options.sandboxId
      ? await Sandbox.connect(options.sandboxId, {
          apiKey: options.apiKey,
          timeoutMs,
        })
      : await Sandbox.create({
          template: options.template,
          apiKey: options.apiKey,
          timeoutMs,
          secure: options.secure ?? true,
        });
    return new E2BAdapter(sandbox, timeoutMs, ownsSandbox);
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    try {
      const result = await this.sandbox.commands.run(command, {
        user: e2bUser(options.user ?? "root"),
        // The e2b SDK defaults an unset command timeout to 60s, which kills real
        // agent work (npm install, builds). 0 disables the per-command timeout;
        // the sandbox's own lifetime + keepAlive bound the session instead.
        timeoutMs: options.timeoutMs ?? 0,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (error instanceof CommandExitError) {
        return {
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr || error.error || "",
        };
      }
      // Timeouts, network failures, and dead sandboxes are infrastructure errors,
      // not command results; mapping them to exitCode 1 would hide sandbox loss.
      throw error;
    }
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const url = await this.sandbox.uploadUrl(remotePath, {
      user: "root",
      useSignatureExpiration: 600,
    });
    const body = await readFile(localPath);
    await fetchWithRetry(`E2B upload of ${remotePath}`, async () => {
      const form = new FormData();
      form.append("file", new Blob([body], { type: "application/octet-stream" }), basename(localPath));
      return fetch(url, { method: "POST", body: form });
    });
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const url = await this.sandbox.downloadUrl(remotePath, {
      user: "root",
      useSignatureExpiration: 600,
    });
    const response = await fetchWithRetry(`E2B download of ${remotePath}`, () => fetch(url));
    if (!response.body) {
      throw new Error(`E2B download of ${remotePath} returned an empty body`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(localPath, { mode: 0o600 }));
  }

  async keepAlive(): Promise<void> {
    // Resets the auto-kill countdown so the sandbox outlives long sessions.
    await this.sandbox.setTimeout(this.timeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.ownsSandbox && typeof this.sandbox.kill === "function") {
      await this.sandbox.kill();
    }
  }
}

function e2bUser(user: string): Username {
  if (user === "root" || user === "user") {
    return user;
  }
  throw new Error(`E2B runtime only supports user "root" or "user", got: ${user}`);
}

/**
 * The presigned-URL transfer goes through plain fetch, outside the SDK's transport.
 * Fresh sandboxes can take >10s before their public hostname accepts connections,
 * which surfaces as UND_ERR_CONNECT_TIMEOUT; retrying makes attach reliable.
 */
async function fetchWithRetry(label: string, attempt: () => Promise<Response>): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i <= transferRetryDelaysMs.length; i++) {
    if (i > 0) {
      await delay(transferRetryDelaysMs[i - 1]);
    }
    let response: Response;
    try {
      response = await attempt();
    } catch (error) {
      // Network-level failure (connect timeout, reset, DNS). Always retryable.
      lastError = error;
      continue;
    }
    if (response.ok) {
      return response;
    }
    const detail = `${label} failed: ${response.status} ${await response.text().catch(() => "")}`.trim();
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      lastError = new Error(detail);
      continue;
    }
    throw new Error(detail);
  }
  throw lastError instanceof Error
    ? new Error(`${label} failed after ${transferRetryDelaysMs.length + 1} attempts: ${lastError.message}`, { cause: lastError })
    : new Error(`${label} failed after ${transferRetryDelaysMs.length + 1} attempts`);
}
