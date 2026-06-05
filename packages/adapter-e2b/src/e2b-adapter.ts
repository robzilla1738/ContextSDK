import { basename } from "node:path";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CommandExitError, Sandbox, type Username } from "e2b";
import { defaultMountPath } from "@contextsdk/core";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "@contextsdk/core";

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
  private readonly sandbox: Sandbox;

  private constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
    this.id = `e2b:${sandbox.sandboxId}`;
  }

  defaultMountPath(contextId: string): string {
    return defaultMountPath(contextId);
  }

  static async create(options: E2BAdapterOptions = {}): Promise<E2BAdapter> {
    if (options.sandbox) {
      return new E2BAdapter(options.sandbox);
    }
    const createOptions = {
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      secure: options.secure ?? true,
    };
    const connectOptions = {
      apiKey: options.apiKey,
      secure: options.secure ?? true,
    };
    const sandbox = options.sandboxId
      ? await Sandbox.connect(options.sandboxId, connectOptions)
      : options.template
        ? await Sandbox.create(options.template, createOptions)
        : await Sandbox.create(createOptions);
    return new E2BAdapter(sandbox);
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    try {
      const result = await this.sandbox.commands.run(command, {
        user: e2bUser(options.user ?? "root"),
        timeoutMs: options.timeoutMs,
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
    const form = new FormData();
    const file = new Blob([await readFile(localPath)], {
      type: "application/octet-stream",
    });
    form.append("file", file, basename(localPath));
    const response = await fetch(url, { method: "POST", body: form });
    if (!response.ok) {
      throw new Error(`E2B upload failed: ${response.status} ${await response.text()}`);
    }
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const url = await this.sandbox.downloadUrl(remotePath, {
      user: "root",
      useSignatureExpiration: 600,
    });
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`E2B download failed: ${response.status} ${await response.text()}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(localPath, { mode: 0o600 }));
  }

  async dispose(): Promise<void> {
    if (typeof this.sandbox.kill === "function") {
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
