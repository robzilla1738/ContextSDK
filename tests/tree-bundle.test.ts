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
});

function hasCommand(command: string): boolean {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
