import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ContextSDKError } from "./errors.js";
import { defaultLayout } from "./paths.js";

export interface PrepareContextTreeOptions {
  root: string;
  contextId: string;
}

export interface PackContextTreeOptions {
  root: string;
  archivePath: string;
}

export interface UnpackContextTreeOptions {
  archivePath: string;
  destination: string;
}

export async function prepareContextTree(options: PrepareContextTreeOptions): Promise<void> {
  await rm(options.root, { recursive: true, force: true });
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  for (const directory of [...defaultLayout, ".contextsdk"]) {
    await mkdir(join(options.root, directory), { recursive: true, mode: 0o777 });
    await chmod(join(options.root, directory), 0o777);
  }
  await writeFile(join(options.root, "contextsdk.json"), JSON.stringify({
    contextId: options.contextId,
    createdBy: "contextSDK",
    layout: [...defaultLayout],
    format: "tree",
  }, null, 2) + "\n", { mode: 0o644 });
  await writeFile(join(options.root, "memory", "session.md"), `context=${options.contextId}\nstatus=initialized\n`, { mode: 0o666 });
  await writeFile(join(options.root, "workspace", "README.md"), "Portable agent workspace mounted by contextSDK.\n", { mode: 0o666 });
  await writeTreeIndex(options.root);
}

export async function packContextTree(options: PackContextTreeOptions): Promise<void> {
  await requireTool("tar");
  await requireTool("zstd");
  await rm(options.archivePath, { force: true });
  await runPipeline([
    { command: "tar", args: ["-C", options.root, "-cf", "-", "."] },
    { command: "zstd", args: ["-T0", "-q", "-o", options.archivePath] },
  ]);
}

export async function unpackContextTree(options: UnpackContextTreeOptions): Promise<void> {
  await requireTool("tar");
  await requireTool("zstd");
  await assertSafeArchive(options.archivePath);
  await rm(options.destination, { recursive: true, force: true });
  await mkdir(options.destination, { recursive: true, mode: 0o700 });
  await runPipeline([
    { command: "zstd", args: ["-dc", options.archivePath] },
    { command: "tar", args: ["-C", options.destination, "-xf", "-"] },
  ]);
}

export async function assertSafeArchive(archivePath: string): Promise<void> {
  const listing = await runCapture("sh", ["-lc", `zstd -dc ${shellArg(archivePath)} | tar -tf -`]);
  for (const rawEntry of listing.split("\n")) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    const normalized = entry.replace(/^\.\//, "");
    if (
      entry.startsWith("/")
      || normalized === ".."
      || normalized.startsWith("../")
      || normalized.includes("/../")
      || normalized.includes("\0")
    ) {
      throw new ContextSDKError(`unsafe archive entry: ${entry}`);
    }
  }
}

async function writeTreeIndex(root: string): Promise<void> {
  const files = await listFiles(root);
  const entries = [];
  for (const file of files.filter(file => !file.startsWith(".contextsdk/")).sort()) {
    const fullPath = join(root, file);
    const info = await stat(fullPath);
    const data = await import("node:fs/promises").then(fs => fs.readFile(fullPath));
    entries.push({
      path: file,
      size: info.size,
      mode: `0o${(info.mode & 0o777).toString(8)}`,
      mtime: info.mtime.toISOString(),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  await writeFile(join(root, ".contextsdk", "index.json"), JSON.stringify({
    version: 1,
    files: entries,
  }, null, 2) + "\n", { mode: 0o644 });
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

async function requireTool(name: string): Promise<void> {
  const result = await runProcess("sh", ["-lc", `command -v ${shellArg(name)}`]);
  if (result.exitCode !== 0) {
    throw new ContextSDKError(`missing required local tool: ${name}`);
  }
}

async function runCapture(command: string, args: string[]): Promise<string> {
  const result = await runProcess(command, args);
  if (result.exitCode !== 0) {
    throw new ContextSDKError(`${command} failed with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim());
  }
  return result.stdout;
}

function runPipeline(stages: Array<{ command: string; args: string[] }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const children = stages.map(stage => spawn(stage.command, stage.args, { stdio: ["pipe", "pipe", "pipe"] }));
    const stderr: Buffer[] = [];
    for (let index = 0; index < children.length - 1; index += 1) {
      children[index].stdout.pipe(children[index + 1].stdin);
    }
    for (const child of children) {
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
    }
    children[0].stdin.end();
    let remaining = children.length;
    let failed = false;
    children.forEach((child, index) => {
      child.on("close", code => {
        if (code !== 0 && !failed) {
          failed = true;
          reject(new ContextSDKError(`${stages[index].command} failed with exit code ${code}\n${Buffer.concat(stderr).toString("utf8")}`.trim()));
          return;
        }
        remaining -= 1;
        if (remaining === 0 && !failed) {
          resolve();
        }
      });
    });
  });
}

function runProcess(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
