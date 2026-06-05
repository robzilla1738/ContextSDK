import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import type { RuntimeAdapter, RuntimeCommandResult, RuntimeRunOptions } from "./runtime.js";
import { shellQuote } from "./shell.js";

/** Matches the core default remote-command timeout so large bundle transfers are not SIGKILLed early. */
const defaultTransferTimeoutMs = 15 * 60_000;

export interface SSHAdapterOptions {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  id?: string;
  /** Seconds ssh/scp wait for the TCP connection before failing. */
  connectTimeoutSeconds?: number;
  /** Hard ceiling for an ssh command or scp transfer. Large bundles need a generous value. */
  transferTimeoutMs?: number;
}

export class SSHAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly provider = "ssh";
  /**
   * SSH hosts attach via the unprivileged directory-bundle path. The loop-ext4
   * path needs losetup/mount on an arbitrary host, which is exactly what the
   * attach-only SSH runtime must not assume.
   */
  readonly capabilities = {
    loopExt4: false,
    directoryBundle: true,
    providerVolume: false,
    providerSnapshot: false,
  };
  private readonly options: SSHAdapterOptions;

  constructor(options: SSHAdapterOptions) {
    this.options = options;
    this.id = options.id ?? `ssh:${options.user ? `${options.user}@` : ""}${options.host}`;
  }

  async run(command: string, options: RuntimeRunOptions = {}): Promise<RuntimeCommandResult> {
    // Core scripts use `set -Eeuo pipefail`, which dash (the default /bin/sh on
    // Debian-family hosts) rejects; always run them under bash explicitly.
    const shellCommand = `bash -lc ${shellQuote(command)}`;
    const remoteCommand = options.user && options.user !== this.options.user
      ? `sudo -n -u ${shellQuote(options.user)} ${shellCommand}`
      : shellCommand;
    return spawnCapture("ssh", [...this.sshArgs(), this.target(), remoteCommand], options.timeoutMs);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    // Bundle transfers can be large; give scp the same generous budget as remote
    // commands rather than the 5-minute spawnCapture default.
    const result = await spawnCapture("scp", [...this.scpArgs(), localPath, `${this.target()}:${remotePath}`], this.options.transferTimeoutMs ?? defaultTransferTimeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`scp upload failed: ${result.stderr || result.stdout}`);
    }
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const result = await spawnCapture("scp", [...this.scpArgs(), `${this.target()}:${remotePath}`, localPath], this.options.transferTimeoutMs ?? defaultTransferTimeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`scp download failed: ${result.stderr || result.stdout}`);
    }
    // Downloaded bundles are decrypted context data; keep them private locally.
    await chmod(localPath, 0o600);
  }

  commandForTest(command: string): string[] {
    return ["ssh", ...this.sshArgs(), this.target(), command];
  }

  private target(): string {
    return `${this.options.user ? `${this.options.user}@` : ""}${this.options.host}`;
  }

  /**
   * BatchMode keeps ssh from hanging on host-key or password prompts that can
   * never be answered (stdin is closed); ConnectTimeout fails unreachable hosts
   * quickly instead of waiting out the full command timeout.
   */
  private connectionArgs(): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${this.options.connectTimeoutSeconds ?? 10}`,
    ];
  }

  private sshArgs(): string[] {
    const args: string[] = [...this.connectionArgs()];
    if (this.options.port) {
      args.push("-p", String(this.options.port));
    }
    if (this.options.identityFile) {
      args.push("-i", this.options.identityFile);
    }
    return args;
  }

  private scpArgs(): string[] {
    const args: string[] = [...this.connectionArgs()];
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
