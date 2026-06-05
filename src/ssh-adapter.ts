import { spawn } from "node:child_process";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "./runtime.js";
import { shellQuote } from "./shell.js";

export interface SSHAdapterOptions {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  id?: string;
}

export class SSHAdapter implements RuntimeAdapter {
  readonly id: string;
  private readonly options: SSHAdapterOptions;

  constructor(options: SSHAdapterOptions) {
    this.options = options;
    this.id = options.id ?? `ssh:${options.user ? `${options.user}@` : ""}${options.host}`;
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    const remoteCommand = options.user && options.user !== this.options.user
      ? `sudo -u ${shellQuote(options.user)} sh -lc ${shellQuote(command)}`
      : command;
    return spawnCapture("ssh", [...this.sshArgs(), this.target(), remoteCommand], options.timeoutMs);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const result = await spawnCapture("scp", [...this.scpArgs(), localPath, `${this.target()}:${remotePath}`]);
    if (result.exitCode !== 0) {
      throw new Error(`scp upload failed: ${result.stderr || result.stdout}`);
    }
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const result = await spawnCapture("scp", [...this.scpArgs(), `${this.target()}:${remotePath}`, localPath]);
    if (result.exitCode !== 0) {
      throw new Error(`scp download failed: ${result.stderr || result.stdout}`);
    }
  }

  commandForTest(command: string): string[] {
    return ["ssh", ...this.sshArgs(), this.target(), command];
  }

  private target(): string {
    return `${this.options.user ? `${this.options.user}@` : ""}${this.options.host}`;
  }

  private sshArgs(): string[] {
    const args: string[] = [];
    if (this.options.port) {
      args.push("-p", String(this.options.port));
    }
    if (this.options.identityFile) {
      args.push("-i", this.options.identityFile);
    }
    return args;
  }

  private scpArgs(): string[] {
    const args: string[] = [];
    if (this.options.port) {
      args.push("-P", String(this.options.port));
    }
    if (this.options.identityFile) {
      args.push("-i", this.options.identityFile);
    }
    return args;
  }
}

function spawnCapture(command: string, args: string[], timeoutMs = 300_000): Promise<RuntimeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
