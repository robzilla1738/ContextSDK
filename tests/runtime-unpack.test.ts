import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unpackBundleScript } from "../src/scripts.js";

const toolsAvailable = ["bash", "tar", "zstd", "python3"].every(hasCommand);

/** Builds a malicious .tar.zst via python tarfile, which can record arbitrary entry names. */
async function craftBundle(dir: string, pythonBody: string): Promise<string> {
  const tarPath = join(dir, "evil.tar");
  const bundlePath = join(dir, "evil.tar.zst");
  const script = [
    "import io, tarfile, sys",
    `archive = tarfile.open(${JSON.stringify(tarPath)}, 'w')`,
    pythonBody,
    "archive.close()",
  ].join("\n");
  execFileSync("python3", ["-c", script]);
  execFileSync("zstd", ["-q", "-f", tarPath, "-o", bundlePath]);
  return bundlePath;
}

function runUnpack(bundlePath: string, mountPath: string): { status: number; stderr: string } {
  const result = spawnSync("bash", ["-c", unpackBundleScript(bundlePath, mountPath)], { encoding: "utf8" });
  return { status: result.status ?? 1, stderr: result.stderr };
}

describe("runtime bundle unpack validation", () => {
  it.runIf(toolsAvailable)("rejects path traversal entries before extraction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-unpack-"));
    try {
      const bundle = await craftBundle(dir, [
        "info = tarfile.TarInfo('../escaped.txt')",
        "data = b'pwned'",
        "info.size = len(data)",
        "archive.addfile(info, io.BytesIO(data))",
      ].join("\n"));
      const mount = join(dir, "mount", "ctx");
      await mkdir(mount, { recursive: true });
      const result = runUnpack(bundle, mount);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unsafe archive entry/);
      await expect(access(join(dir, "mount", "escaped.txt"))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(toolsAvailable)("rejects symlinks whose targets escape the mount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-unpack-"));
    try {
      const bundle = await craftBundle(dir, [
        "info = tarfile.TarInfo('workspace/leak')",
        "info.type = tarfile.SYMTYPE",
        "info.linkname = '../../outside'",
        "archive.addfile(info)",
      ].join("\n"));
      const mount = join(dir, "mount", "ctx");
      await mkdir(mount, { recursive: true });
      const result = runUnpack(bundle, mount);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unsafe archive link target/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(toolsAvailable)("rejects special files such as FIFOs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-unpack-"));
    try {
      const bundle = await craftBundle(dir, [
        "info = tarfile.TarInfo('workspace/pipe')",
        "info.type = tarfile.FIFOTYPE",
        "archive.addfile(info)",
      ].join("\n"));
      const mount = join(dir, "mount", "ctx");
      await mkdir(mount, { recursive: true });
      const result = runUnpack(bundle, mount);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unsupported archive entry type/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(toolsAvailable)("extracts a benign bundle and removes the decrypted source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-unpack-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "workspace"), { recursive: true });
      await writeFile(join(src, "workspace", "ok.txt"), "fine\n");
      const tarPath = join(dir, "good.tar");
      const bundle = join(dir, "good.tar.zst");
      execFileSync("tar", ["-C", src, "-cf", tarPath, "workspace"]);
      execFileSync("zstd", ["-q", "-f", tarPath, "-o", bundle]);

      const mount = join(dir, "mount", "ctx");
      const result = runUnpack(bundle, mount);
      expect(result.status).toBe(0);
      await expect(access(join(mount, "workspace", "ok.txt"))).resolves.toBeUndefined();
      // Decrypted bundle bytes must not linger on the runtime after extraction.
      await expect(access(bundle)).rejects.toThrow();
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
