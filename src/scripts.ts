import { shellQuote } from "./shell.js";
import { resolvePersistencePolicy } from "./persistence-policy.js";
import type { ContextPersistencePolicy } from "./types.js";

export function ensureRuntimeToolsScript(): string {
  return [
    "set -Eeuo pipefail",
    "for cmd in losetup mount umount e2fsck findmnt mkdir sync python3 sha256sum; do command -v \"$cmd\" >/dev/null 2>&1 || { echo \"missing $cmd\" >&2; exit 30; }; done",
  ].join("\n");
}

export function ensureDirectoryBundleToolsScript(): string {
  return [
    "set -Eeuo pipefail",
    "if ! command -v tar >/dev/null 2>&1; then echo \"missing tar\" >&2; exit 30; fi",
    "if ! command -v zstd >/dev/null 2>&1; then",
    "  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y zstd; elif command -v dnf >/dev/null 2>&1; then dnf install -y zstd; else echo \"missing zstd\" >&2; exit 31; fi",
    "fi",
    "command -v zstd >/dev/null 2>&1 || { echo \"missing zstd\" >&2; exit 31; }",
  ].join("\n");
}

export function mountScript(imagePath: string, mountPath: string): string {
  return [
    "set -Eeuo pipefail",
    `image=${shellQuote(imagePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    "mkdir -p \"$mountpoint\"",
    "loopdev=\"$(losetup --find --show \"$image\")\"",
    // Release the loop device if anything after losetup fails; cleared on success.
    "trap 'losetup -d \"$loopdev\" 2>/dev/null || true' EXIT",
    "mount -t ext4 \"$loopdev\" \"$mountpoint\"",
    "for root in workspace memory artifacts logs cache config; do mkdir -p \"$mountpoint/$root\"; if [ -L \"/$root\" ] || [ ! -e \"/$root\" ]; then ln -sfn \"$mountpoint/$root\" \"/$root\"; fi; done",
    "findmnt --target \"$mountpoint\"",
    "trap - EXIT",
    "printf 'CONTEXTSDK_MOUNT_JSON=%s\\n' \"{\\\"loopDevice\\\":\\\"$loopdev\\\",\\\"mountPath\\\":\\\"$mountpoint\\\",\\\"remoteImagePath\\\":\\\"$image\\\"}\"",
  ].join("\n");
}

export function unpackBundleScript(bundlePath: string, mountPath: string, policy?: Partial<ContextPersistencePolicy>): string {
  const resolvedPolicy = resolvePersistencePolicy(policy);
  return [
    "set -Eeuo pipefail",
    ensureDirectoryBundleToolsScript(),
    `bundle=${shellQuote(bundlePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    `policy=${shellQuote(JSON.stringify(resolvedPolicy))}`,
    "mkdir -p \"$mountpoint\"",
    "CONTEXTSDK_POLICY=\"$policy\" CONTEXTSDK_MOUNT=\"$mountpoint\" python3 - <<'PY'",
    "import json, os, pathlib, shutil",
    "mount = pathlib.Path(os.environ['CONTEXTSDK_MOUNT'])",
    "policy = json.loads(os.environ['CONTEXTSDK_POLICY'])",
    "targets = ['.contextsdk', 'contextsdk.json', *policy.get('roots', [])]",
    "seen = set()",
    "for target in targets:",
    "    if not target or target in seen:",
    "        continue",
    "    seen.add(target)",
    "    path = mount / target",
    "    if path.is_symlink() or path.is_file():",
    "        path.unlink()",
    "    elif path.is_dir():",
    "        shutil.rmtree(path)",
    "PY",
    "zstd -dc \"$bundle\" | tar -C \"$mountpoint\" -xf -",
    // The bundle on the runtime is decrypted context data; remove it once extracted.
    "rm -f \"$bundle\"",
    "for root in workspace memory artifacts logs cache config; do mkdir -p \"$mountpoint/$root\"; if [ -L \"/$root\" ] || [ ! -e \"/$root\" ]; then ln -sfn \"$mountpoint/$root\" \"/$root\"; fi; done",
    "printf 'CONTEXTSDK_MOUNT_JSON=%s\\n' \"{\\\"mountPath\\\":\\\"$mountpoint\\\",\\\"remoteBundlePath\\\":\\\"$bundle\\\",\\\"mode\\\":\\\"directoryBundle\\\"}\"",
  ].join("\n");
}

export function packBundleScript(bundlePath: string, mountPath: string, policy?: Partial<ContextPersistencePolicy>): string {
  const resolvedPolicy = resolvePersistencePolicy(policy);
  return [
    "set -Eeuo pipefail",
    ensureDirectoryBundleToolsScript(),
    `bundle=${shellQuote(bundlePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    `policy=${shellQuote(JSON.stringify(resolvedPolicy))}`,
    "test -d \"$mountpoint\"",
    "rm -f \"$bundle\"",
    "sync \"$mountpoint\" 2>/dev/null || sync",
    "tmp_tar=\"$(mktemp)\"",
    "trap 'rm -f \"$tmp_tar\"' EXIT",
    "CONTEXTSDK_POLICY=\"$policy\" CONTEXTSDK_MOUNT=\"$mountpoint\" CONTEXTSDK_TAR=\"$tmp_tar\" python3 - <<'PY'",
    "import fnmatch, json, os, pathlib, tarfile",
    "mount = pathlib.Path(os.environ['CONTEXTSDK_MOUNT'])",
    "tar_path = pathlib.Path(os.environ['CONTEXTSDK_TAR'])",
    "policy = json.loads(os.environ['CONTEXTSDK_POLICY'])",
    "roots = ['.contextsdk', 'contextsdk.json', *policy.get('roots', [])]",
    "patterns = policy.get('exclude', [])",
    "def excluded(rel):",
    "    rel = rel.replace('\\\\', '/')",
    "    for pattern in patterns:",
    "        trimmed = pattern[:-3] if pattern.endswith('/**') else pattern",
    "        if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(rel, trimmed) or (trimmed and rel.startswith(trimmed.rstrip('/') + '/')):",
    "            return True",
    "    return False",
    "def unsafe_link(info):",
    "    if not (info.issym() or info.islnk()):",
    "        return False",
    "    target = info.linkname.replace('\\\\', '/')",
    "    return target.startswith('/') or '..' in target.split('/')",
    "def tar_filter(info):",
    "    rel = info.name.replace('\\\\', '/')",
    "    if excluded(rel):",
    "        return None",
    "    if unsafe_link(info):",
    "        return None",
    "    if not (info.isfile() or info.isdir() or info.issym() or info.islnk()):",
    "        return None",
    "    return info",
    "with tarfile.open(tar_path, 'w') as archive:",
    "    seen = set()",
    "    for root in roots:",
    "        if not root or root in seen:",
    "            continue",
    "        seen.add(root)",
    "        path = mount / root",
    "        if path.exists() and not excluded(root):",
    "            archive.add(path, arcname=root, filter=tar_filter)",
    "PY",
    "zstd -T0 -q -f \"$tmp_tar\" -o \"$bundle\"",
    "test -s \"$bundle\"",
  ].join("\n");
}

export function saveScript(imagePath: string, mountPath: string): string {
  return [
    "set -Eeuo pipefail",
    `image=${shellQuote(imagePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    "source=\"$(findmnt -n -o SOURCE --target \"$mountpoint\" || true)\"",
    "test -n \"$source\"",
    "sync",
    // Busy filesystems are common right after agent workloads; retry once before failing.
    "umount \"$mountpoint\" || { sync; sleep 1; umount \"$mountpoint\"; }",
    "if printf '%s' \"$source\" | grep -q '^/dev/loop'; then losetup -d \"$source\"; fi",
    "e2fsck -fn \"$image\"",
  ].join("\n");
}

export function detachScript(imagePath: string, mountPath: string, cleanupRemote: boolean): string {
  return [
    "set -Eeuo pipefail",
    `image=${shellQuote(imagePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    "for root in workspace memory artifacts logs cache config; do if [ -L \"/$root\" ] && [ \"$(readlink \"/$root\")\" = \"$mountpoint/$root\" ]; then rm -f \"/$root\"; fi; done",
    "if mountpoint -q \"$mountpoint\"; then source=\"$(findmnt -n -o SOURCE --target \"$mountpoint\")\"; umount \"$mountpoint\"; if printf '%s' \"$source\" | grep -q '^/dev/loop'; then losetup -d \"$source\"; fi; fi",
    cleanupRemote ? "rm -f \"$image\"" : "true",
  ].join("\n");
}

export function detachDirectoryScript(bundlePath: string, mountPath: string, cleanupRemote: boolean): string {
  return [
    "set -Eeuo pipefail",
    `bundle=${shellQuote(bundlePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    "for root in workspace memory artifacts logs cache config; do if [ -L \"/$root\" ] && [ \"$(readlink \"/$root\")\" = \"$mountpoint/$root\" ]; then rm -f \"/$root\"; fi; done",
    cleanupRemote ? "rm -f \"$bundle\"" : "true",
  ].join("\n");
}
