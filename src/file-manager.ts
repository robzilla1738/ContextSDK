import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertSuccess, type RuntimeAdapter } from "./runtime.js";
import { remoteContextPath, normalizeContextPath } from "./path-policy.js";
import { shellQuote } from "./shell.js";
import { ContextSDKError } from "./errors.js";

export class MountedContextFileManager {
  constructor(
    private readonly runtime: RuntimeAdapter,
    private readonly mountPath: string,
  ) {}

  resolve(path: string): string {
    return remoteContextPath(this.mountPath, path);
  }

  async write(path: string, data: string | Buffer | Uint8Array): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-file-"));
    const localPath = join(tempDir, basename(path) || "data");
    const remoteTempPath = `/tmp/contextsdk-write-${randomUUID()}`;
    const target = this.resolve(path);
    try {
      await writeFile(localPath, data, { mode: 0o600 });
      await this.runtime.uploadFile(localPath, remoteTempPath);
      assertSuccess(await this.runtime.run([
        "set -Eeuo pipefail",
        `mkdir -p ${shellQuote(dirnameRemote(target))}`,
        `mv ${shellQuote(remoteTempPath)} ${shellQuote(target)}`,
      ].join("\n"), { user: "root" }), "write context file");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async append(path: string, line: string): Promise<void> {
    const target = this.resolve(path);
    const quotedLine = shellQuote(line.endsWith("\n") ? line : `${line}\n`);
    assertSuccess(await this.runtime.run([
      "set -Eeuo pipefail",
      `mkdir -p ${shellQuote(dirnameRemote(target))}`,
      `printf %s ${quotedLine} >> ${shellQuote(target)}`,
    ].join("\n"), { user: "root" }), "append context file");
  }

  async read(path: string): Promise<Buffer> {
    const tempDir = await mkdtemp(join(tmpdir(), "contextsdk-file-"));
    const localPath = join(tempDir, basename(path) || "data");
    try {
      await this.runtime.downloadFile(this.resolve(path), localPath);
      return await readFile(localPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async list(path = "workspace"): Promise<string[]> {
    const root = this.resolve(path);
    const result = await this.runtime.run(
      `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -exec basename {} \\; | sort; fi`,
      { user: "root" },
    );
    assertSuccess(result, "list context files");
    return result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizeContextPath(path);
    if (!normalized.includes("/")) {
      throw new ContextSDKError(`refusing to remove managed root: ${normalized}`);
    }
    const target = this.resolve(normalized);
    assertSuccess(await this.runtime.run(`rm -rf ${shellQuote(target)}`, { user: "root" }), "remove context file");
  }
}

export function createMemoryApi(files: MountedContextFileManager): { append(note: string): Promise<void> } {
  return {
    async append(note: string): Promise<void> {
      await files.append("memory/session.md", note);
    },
  };
}

export function createArtifactsApi(files: MountedContextFileManager): { write(path: string, data: string | Buffer | Uint8Array): Promise<void> } {
  return {
    async write(path: string, data: string | Buffer | Uint8Array): Promise<void> {
      await files.write(`artifacts/${normalizeContextPath(`artifacts/${path}`).replace(/^artifacts\//, "")}`, data);
    },
  };
}

export function createLogsApi(files: MountedContextFileManager): { append(line: string): Promise<void> } {
  return {
    async append(line: string): Promise<void> {
      await files.append("logs/session.log", line);
    },
  };
}

function dirnameRemote(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
