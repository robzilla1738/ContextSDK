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
  // --no-xattrs (supported by both GNU tar and bsdtar) keeps host-specific extended
  // attributes out of the bundle: they are not portable across providers and make
  // macOS bsdtar emit "Could not pack extended attributes" warnings.
  await runPipeline([
    { command: "tar", args: ["--no-xattrs", "-C", options.root, ...excludeArgs, "-cf", "-", ...items] },
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

/** Caps that stop decompression bombs before extraction. Generous for real contexts. */
export const maxArchiveEntries = 1_000_000;
export const maxArchiveDecompressedBytes = 64 * 1024 ** 3;

/**
 * Validates a bundle by streaming the decompressed tar listing through python's
 * tarfile and inspecting each member: traversal, link escapes, special files, and
 * the entry-count + decompressed-byte caps. Streaming (never buffering the whole
 * listing) is what makes the caps real — a bomb aborts the scan instead of OOMing
 * the host first. Mirrors the runtime-side validator in unpackBundleScript exactly.
 */
export async function assertSafeArchive(archivePath: string): Promise<void> {
  await requireTool("python3");
  const script = [
    "import subprocess, sys, tarfile",
    "bundle = sys.argv[1]",
    `MAX_ENTRIES = ${maxArchiveEntries}`,
    `MAX_BYTES = ${maxArchiveDecompressedBytes}`,
    "def unsafe_segments(value):",
    "    value = value.replace('\\\\', '/')",
    "    return value.startswith('/') or '\\x00' in value or '..' in value.split('/')",
    "count = 0",
    "total = 0",
    "proc = subprocess.Popen(['zstd', '-dc', bundle], stdout=subprocess.PIPE)",
    "with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:",
    "    for m in archive:",
    "        count += 1",
    "        if count > MAX_ENTRIES:",
    "            sys.exit('archive exceeds the %d entry limit' % MAX_ENTRIES)",
    "        total += m.size",
    "        if total > MAX_BYTES:",
    "            sys.exit('archive exceeds the %d byte decompressed limit' % MAX_BYTES)",
    "        if unsafe_segments(m.name):",
    "            sys.exit('unsafe archive entry: ' + m.name)",
    "        if (m.issym() or m.islnk()):",
    "            if unsafe_segments(m.linkname):",
    "                sys.exit('unsafe archive link target: %s -> %s' % (m.name, m.linkname))",
    "        elif not (m.isfile() or m.isdir()):",
    "            sys.exit('unsupported archive entry type: ' + m.name)",
    "while proc.stdout.read(1024 * 1024):",
    "    pass",
    "if proc.wait() != 0:",
    "    sys.exit('zstd decompression failed')",
  ].join("\n");
  const result = await runProcess("python3", ["-c", script, archivePath]);
  if (result.exitCode !== 0) {
    throw new ContextSDKError(`unsafe or unreadable archive: ${(result.stderr || result.stdout).trim()}`);
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
  if (items.length === 0) {
    // Falling back to "." would silently pack the entire root, including runtime
    // caches the persistence policy exists to exclude.
    throw new ContextSDKError(`no managed context entries found under ${root}; refusing to pack the whole directory`);
  }
  return items;
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
