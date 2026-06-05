import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ContextSDKError } from "./errors.js";
import { defaultLayout } from "./paths.js";

export interface CreateExt4ImageOptions {
  imagePath: string;
  stagingDir: string;
  sizeBytes: number;
  contextId: string;
  useExistingStagingDir?: boolean;
}

export async function createExt4Image(options: CreateExt4ImageOptions): Promise<void> {
  if (!options.useExistingStagingDir) {
    await rm(options.stagingDir, { recursive: true, force: true });
    await mkdir(options.stagingDir, { recursive: true, mode: 0o700 });
    await prepareAgentLayout(options.stagingDir, options.contextId);
  }
  await rm(options.imagePath, { force: true });
  await runLocal("truncate", ["-s", String(options.sizeBytes), options.imagePath]);
  const mkfs = await findTool(["mkfs.ext4", "mke2fs"]);
  await runLocal(mkfs, ["-F", "-t", "ext4", "-L", "CONTEXTSDK", "-d", options.stagingDir, options.imagePath]);
  await validateExt4Image(options.imagePath);
}

export async function validateExt4Image(imagePath: string): Promise<void> {
  const e2fsck = await findTool(["e2fsck"]);
  await runLocal(e2fsck, ["-fn", imagePath]);
}

export async function parseSize(size: string | number): Promise<number> {
  if (typeof size === "number") {
    return size;
  }
  const match = /^(\d+)([kKmMgG]?)$/.exec(size.trim());
  if (!match) {
    throw new ContextSDKError(`invalid size: ${size}`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return value * multiplier;
}

async function prepareAgentLayout(root: string, contextId: string): Promise<void> {
  for (const directory of defaultLayout) {
    await mkdir(join(root, directory), { recursive: true, mode: 0o777 });
    await chmod(join(root, directory), 0o777);
  }
  const manifest = {
    contextId,
    createdBy: "contextSDK",
    layout: [...defaultLayout],
  };
  await writeFile(join(root, "contextsdk.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  await writeFile(join(root, "memory", "session.md"), `context=${contextId}\nstatus=initialized\n`, { mode: 0o666 });
  await writeFile(join(root, "workspace", "README.md"), "Portable agent workspace mounted by contextSDK.\n", { mode: 0o666 });
  await writeChecksums(root);
}

async function writeChecksums(root: string): Promise<void> {
  const files = await listFiles(root);
  const lines: string[] = [];
  for (const file of files.filter(file => file !== "manifest.sha256").sort()) {
    const data = await import("node:fs/promises").then(fs => fs.readFile(join(root, file)));
    lines.push(`${createHash("sha256").update(data).digest("hex")}  ${file}\n`);
  }
  await writeFile(join(root, "manifest.sha256"), lines.join(""), { mode: 0o644 });
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function findTool(names: string[]): Promise<string> {
  const pathDirs = (process.env.PATH ?? "").split(":");
  const extraDirs = [
    "/opt/homebrew/opt/e2fsprogs/sbin",
    "/opt/homebrew/opt/e2fsprogs/bin",
    "/usr/local/opt/e2fsprogs/sbin",
    "/usr/local/opt/e2fsprogs/bin",
  ];
  for (const name of names) {
    for (const dir of [...pathDirs, ...extraDirs]) {
      const candidate = join(dir, name);
      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  throw new ContextSDKError(`missing required local tool: ${names.join(" or ")}. On macOS run: brew install e2fsprogs`);
}

function runLocal(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new ContextSDKError(`${command} failed with exit code ${code}\n${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`.trim()));
      }
    });
  });
}
