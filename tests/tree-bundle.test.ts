import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeArchive, packContextTree, prepareContextTree, unpackContextTree } from "../src/tree-bundle.js";

const canArchive = hasCommand("tar") && hasCommand("zstd");

describe("tree bundles", () => {
  it.runIf(canArchive)("packs and unpacks managed context roots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-tree-test-"));
    try {
      const root = join(dir, "root");
      const archive = join(dir, "context.tree.tar.zst");
      const unpacked = join(dir, "unpacked");
      await prepareContextTree({ root, contextId: "unit-test" });
      await writeFile(join(root, "workspace", "task.txt"), "persist me\n");
      await mkdir(join(root, "workspace", "node_modules", "pkg"), { recursive: true });
      await mkdir(join(root, "workspace", ".next"), { recursive: true });
      await writeFile(join(root, "workspace", "node_modules", "pkg", "index.js"), "do not persist\n");
      await writeFile(join(root, "workspace", ".next", "build-id"), "do not persist\n");
      await writeFile(join(root, "cache", "runtime-cache.txt"), "runtime only\n");

      await packContextTree({ root, archivePath: archive });
      await unpackContextTree({ archivePath: archive, destination: unpacked });

      await expect(readFile(join(unpacked, "workspace", "task.txt"), "utf8")).resolves.toBe("persist me\n");
      await expect(readFile(join(unpacked, "contextsdk.json"), "utf8")).resolves.toContain("unit-test");
      await expect(readFile(join(unpacked, "workspace", "node_modules", "pkg", "index.js"), "utf8")).rejects.toThrow();
      await expect(readFile(join(unpacked, "workspace", ".next", "build-id"), "utf8")).rejects.toThrow();
      await expect(readFile(join(unpacked, "cache", "runtime-cache.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive)("excludes dependency-heavy paths nested below the top level", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-nested-test-"));
    try {
      const root = join(dir, "root");
      const archive = join(dir, "context.tree.tar.zst");
      const unpacked = join(dir, "unpacked");
      await prepareContextTree({ root, contextId: "nested-test" });
      await mkdir(join(root, "artifacts", "build", "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "artifacts", "build", "node_modules", "pkg", "index.js"), "no\n");
      await mkdir(join(root, "memory", ".venv", "lib"), { recursive: true });
      await writeFile(join(root, "memory", ".venv", "lib", "site.py"), "no\n");
      await mkdir(join(root, "workspace", "app", "dist"), { recursive: true });
      await writeFile(join(root, "workspace", "app", "dist", "bundle.js"), "no\n");
      await writeFile(join(root, "workspace", "app.txt"), "yes\n");

      await packContextTree({ root, archivePath: archive });
      await unpackContextTree({ archivePath: archive, destination: unpacked });

      await expect(readFile(join(unpacked, "workspace", "app.txt"), "utf8")).resolves.toBe("yes\n");
      await expect(readFile(join(unpacked, "artifacts", "build", "node_modules", "pkg", "index.js"))).rejects.toThrow();
      await expect(readFile(join(unpacked, "memory", ".venv", "lib", "site.py"))).rejects.toThrow();
      await expect(readFile(join(unpacked, "workspace", "app", "dist", "bundle.js"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive)("rejects archives containing escaping symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-symlink-test-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "workspace"), { recursive: true });
      await writeFile(join(src, "workspace", "ok.txt"), "fine\n");
      execFileSync("ln", ["-s", "../../outside", join(src, "workspace", "leak")]);
      const archive = await packRaw(dir, src, ["workspace"]);

      await expect(assertSafeArchive(archive)).rejects.toThrow(/unsafe archive link target/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive)("rejects archives containing absolute symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-abs-symlink-test-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "workspace"), { recursive: true });
      execFileSync("ln", ["-s", "/etc/passwd", join(src, "workspace", "leak")]);
      const archive = await packRaw(dir, src, ["workspace"]);

      await expect(assertSafeArchive(archive)).rejects.toThrow(/unsafe archive link target/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive)("allows archives with safe internal symlinks and hardlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-safe-link-test-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "workspace"), { recursive: true });
      await writeFile(join(src, "workspace", "target.txt"), "data\n");
      execFileSync("ln", ["-s", "target.txt", join(src, "workspace", "alias")]);
      execFileSync("ln", [join(src, "workspace", "target.txt"), join(src, "workspace", "hardcopy")]);
      const archive = await packRaw(dir, src, ["workspace"]);

      await expect(assertSafeArchive(archive)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive)("allows regular files whose names mimic link listing markers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-marker-name-test-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "workspace"), { recursive: true });
      await writeFile(join(src, "workspace", "notes link to budget.txt"), "plain file\n");
      await writeFile(join(src, "workspace", "a -> b.txt"), "plain file\n");
      const archive = await packRaw(dir, src, ["workspace"]);

      await expect(assertSafeArchive(archive)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive && hasCommand("mkfifo"))("rejects archives containing special files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-fifo-test-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "workspace"), { recursive: true });
      execFileSync("mkfifo", [join(src, "workspace", "pipe")]);
      const archive = await packRaw(dir, src, ["workspace"]);

      await expect(assertSafeArchive(archive)).rejects.toThrow(/unsupported archive entry type/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive)("rejects archives with traversal entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-unsafe-tree-test-"));
    try {
      const src = join(dir, "src");
      const unsafeTar = join(dir, "unsafe.tar");
      const unsafeZstd = join(dir, "unsafe.tar.zst");
      await prepareContextTree({ root: src, contextId: "unsafe" });
      execFileSync("tar", ["-C", src, "-s", "@workspace/README.md@../escape.md@", "-cf", unsafeTar, "workspace/README.md"]);
      execFileSync("zstd", ["-q", "-f", unsafeTar, "-o", unsafeZstd]);

      await expect(assertSafeArchive(unsafeZstd)).rejects.toThrow(/unsafe archive entry/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canArchive && hasCommand("python3"))("rejects entries with a trailing parent-directory component", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-trailing-test-"));
    try {
      // "workspace/.." resolves to the extraction root's parent edge; tar tools
      // normalize the name away, so craft the archive with python tarfile.
      const unsafeTar = join(dir, "unsafe.tar");
      const unsafeZstd = join(dir, "unsafe.tar.zst");
      execFileSync("python3", ["-c", [
        "import tarfile",
        `archive = tarfile.open(${JSON.stringify(unsafeTar)}, 'w')`,
        "info = tarfile.TarInfo('workspace/..')",
        "info.type = tarfile.DIRTYPE",
        "archive.addfile(info)",
        "archive.close()",
      ].join("\n")]);
      execFileSync("zstd", ["-q", "-f", unsafeTar, "-o", unsafeZstd]);

      await expect(assertSafeArchive(unsafeZstd)).rejects.toThrow(/unsafe archive entry/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function hasCommand(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function packRaw(dir: string, src: string, items: string[]): Promise<string> {
  const tarPath = join(dir, "raw.tar");
  const archivePath = join(dir, "raw.tar.zst");
  execFileSync("tar", ["-C", src, "-cf", tarPath, ...items]);
  execFileSync("zstd", ["-q", "-f", tarPath, "-o", archivePath]);
  return archivePath;
}
