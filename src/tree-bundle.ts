import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ContextSDKError } from "./errors.js";
import { defaultLayout } from "./paths.js";
import { resolvePersistencePolicy } from "./persistence-policy.js";
import type { ContextPersistencePolicy } from "./types.js";

export interface PrepareContextTreeOptions {
  root: string;
  contextId: string;
}

export interface PackContextTreeOptions {
  root: string;
  archivePath: string;
  policy?: Partial<ContextPersistencePolicy>;
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
  const policy = resolvePersistencePolicy(options.policy);
  await rm(options.archivePath, { force: true });
  const items = await existingArchiveItems(options.root, policy);
  const excludeArgs = policy.exclude.flatMap(pattern => ["--exclude", pattern]);
  await runPipeline([
    { command: "tar", args: ["-C", options.root, ...excludeArgs, "-cf", "-", ...items] },
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
  // `tar -tf` hides entry types and link targets, so a second, verbose pass guards
  // against symlink/hardlink escapes and special files that the name check cannot see.
  const verbose = await runCapture("sh", ["-lc", `zstd -dc ${shellArg(archivePath)} | tar -tvf -`]);
  for (const rawLine of verbose.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const typeChar = line[0];
    if (typeChar === "b" || typeChar === "c" || typeChar === "p" || typeChar === "s") {
      throw new ContextSDKError(`unsafe archive entry type '${typeChar}': ${line}`);
    }
    if (typeChar === "l") {
      const marker = line.indexOf(" -> ");
      if (marker === -1) {
        throw new ContextSDKError(`unreadable symlink archive entry: ${line}`);
      }
      if (line.indexOf(" -> ", marker + 4) !== -1) {
        // More than one marker means the name or target embeds the separator;
        // the target cannot be parsed unambiguously, so fail closed.
        throw new ContextSDKError(`ambiguous symlink archive entry: ${line}`);
      }
      assertSafeLinkTarget(line.slice(marker + 4), line);
    }
    // Only entries typed 'h' are hardlinks; matching " link to " on other lines
    // would falsely reject regular files whose names contain that text.
    if (typeChar === "h") {
      const hardlinkMarker = line.lastIndexOf(" link to ");
      if (hardlinkMarker === -1) {
        throw new ContextSDKError(`unreadable hardlink archive entry: ${line}`);
      }
      assertSafeLinkTarget(line.slice(hardlinkMarker + " link to ".length), line);
    }
  }
}

function assertSafeLinkTarget(target: string, line: string): void {
  const trimmed = target.trim();
  if (
    trimmed.startsWith("/")
    || trimmed.includes("\0")
    || trimmed.split("/").includes("..")
  ) {
    throw new ContextSDKError(`unsafe archive link target: ${line}`);
  }
}

async function writeTreeIndex(root: string): Promise<void> {
  const files = await listFiles(root);
  const entries = [];
  const policy = resolvePersistencePolicy();
  for (const file of files.filter(file => !file.startsWith(".contextsdk/") && shouldPersistPath(file, policy)).sort()) {
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

async function existingArchiveItems(root: string, policy: ContextPersistencePolicy): Promise<string[]> {
  const candidates = [".contextsdk", "contextsdk.json", ...policy.roots];
  const items: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || shouldExcludePath(candidate, policy.exclude)) {
      continue;
    }
    seen.add(candidate);
    try {
      await stat(join(root, candidate));
      items.push(candidate);
    } catch {
      continue;
    }
  }
  return items.length ? items : ["."];
}

function shouldPersistPath(path: string, policy: ContextPersistencePolicy): boolean {
  return policy.roots.some(root => path === root || path.startsWith(`${root}/`))
    && !shouldExcludePath(path, policy.exclude);
}

function shouldExcludePath(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    const trimmed = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    return globLike(path, pattern)
      || globLike(path, trimmed)
      || (trimmed ? path.startsWith(`${trimmed.replace(/^\*\*\//, "")}/`) : false);
  });
}

function globLike(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/\*\*/g, "__CONTEXTSDK_GLOBSTAR__")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/__CONTEXTSDK_GLOBSTAR__/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
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
