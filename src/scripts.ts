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
    "if ! command -v python3 >/dev/null 2>&1; then",
    "  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y python3; elif command -v dnf >/dev/null 2>&1; then dnf install -y python3; else echo \"missing python3\" >&2; exit 32; fi",
    "fi",
    "command -v python3 >/dev/null 2>&1 || { echo \"missing python3\" >&2; exit 32; }",
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
    // The /workspace-style root symlinks are convenience sugar; a read-only or
    // pre-populated / must not fail the attach. The canonical path is $mountpoint.
    "for root in workspace memory artifacts logs cache config; do mkdir -p \"$mountpoint/$root\"; if [ -L \"/$root\" ] || [ ! -e \"/$root\" ]; then ln -sfn \"$mountpoint/$root\" \"/$root\" 2>/dev/null || true; fi; done",
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
    // Stream-extract with per-member validation: the archive-safety invariant must hold
    // on the runtime too, where extraction runs as root. python decompresses through a
    // zstd subprocess so a decompression bomb never lands on disk: caps abort mid-stream.
    "CONTEXTSDK_MOUNT=\"$mountpoint\" python3 - \"$bundle\" <<'PY'",
    "import os, subprocess, sys, tarfile",
    "mount = os.environ['CONTEXTSDK_MOUNT']",
    "mount_real = os.path.realpath(mount)",
    "bundle = sys.argv[1]",
    "MAX_ENTRIES = 1000000",
    "MAX_BYTES = 64 * 1024**3",
    "def unsafe_segments(value):",
    "    value = value.replace('\\\\', '/')",
    "    return value.startswith('/') or '\\x00' in value or '..' in value.split('/')",
    "def escapes_mount(name):",
    "    # Catches extraction THROUGH a symlink created earlier in the archive,",
    "    # which name checks alone cannot see (and python < 3.12 has no 'data' filter).",
    "    parent = os.path.realpath(os.path.join(mount_real, os.path.dirname(name)))",
    "    return parent != mount_real and not parent.startswith(mount_real + os.sep)",
    "count = 0",
    "total = 0",
    "proc = subprocess.Popen(['zstd', '-dc', bundle], stdout=subprocess.PIPE)",
    "with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:",
    "    for member in archive:",
    "        count += 1",
    "        if count > MAX_ENTRIES:",
    "            sys.exit('archive exceeds the %d entry limit' % MAX_ENTRIES)",
    "        total += member.size",
    "        if total > MAX_BYTES:",
    "            sys.exit('archive exceeds the %d byte decompressed limit' % MAX_BYTES)",
    "        if unsafe_segments(member.name):",
    "            sys.exit('unsafe archive entry: ' + member.name)",
    "        if (member.issym() or member.islnk()) and unsafe_segments(member.linkname):",
    "            sys.exit('unsafe archive link target: %s -> %s' % (member.name, member.linkname))",
    "        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):",
    "            sys.exit('unsupported archive entry type: ' + member.name)",
    "        if escapes_mount(member.name):",
    "            sys.exit('archive entry resolves outside the mount: ' + member.name)",
    "        try:",
    "            archive.extract(member, path=mount, filter='data')",
    "        except TypeError:",
    "            archive.extract(member, path=mount)",
    "# Streaming tarfile stops at the tar EOF marker; drain any trailing bytes in the",
    "# zstd frame or zstd blocks on a full pipe and proc.wait() never returns.",
    "while proc.stdout.read(1024 * 1024):",
    "    pass",
    "if proc.wait() != 0:",
    "    sys.exit('zstd decompression failed')",
    "PY",
    // The bundle on the runtime is decrypted context data; remove it once extracted.
    "rm -f \"$bundle\"",
    // Convenience symlinks only; never fail the attach over a read-only /.
    "for root in workspace memory artifacts logs cache config; do mkdir -p \"$mountpoint/$root\"; if [ -L \"/$root\" ] || [ ! -e \"/$root\" ]; then ln -sfn \"$mountpoint/$root\" \"/$root\" 2>/dev/null || true; fi; done",
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
