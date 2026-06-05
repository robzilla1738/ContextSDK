import { shellQuote } from "./shell.js";

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
    "mount -t ext4 \"$loopdev\" \"$mountpoint\"",
    "for root in workspace memory artifacts logs cache config; do mkdir -p \"$mountpoint/$root\"; if [ -L \"/$root\" ] || [ ! -e \"/$root\" ]; then ln -sfn \"$mountpoint/$root\" \"/$root\"; fi; done",
    "findmnt --target \"$mountpoint\"",
    "printf 'CONTEXTSDK_MOUNT_JSON=%s\\n' \"{\\\"loopDevice\\\":\\\"$loopdev\\\",\\\"mountPath\\\":\\\"$mountpoint\\\",\\\"remoteImagePath\\\":\\\"$image\\\"}\"",
  ].join("\n");
}

export function unpackBundleScript(bundlePath: string, mountPath: string): string {
  return [
    "set -Eeuo pipefail",
    ensureDirectoryBundleToolsScript(),
    `bundle=${shellQuote(bundlePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    "rm -rf \"$mountpoint\"",
    "mkdir -p \"$mountpoint\"",
    "zstd -dc \"$bundle\" | tar -C \"$mountpoint\" -xf -",
    "for root in workspace memory artifacts logs cache config; do mkdir -p \"$mountpoint/$root\"; if [ -L \"/$root\" ] || [ ! -e \"/$root\" ]; then ln -sfn \"$mountpoint/$root\" \"/$root\"; fi; done",
    "printf 'CONTEXTSDK_MOUNT_JSON=%s\\n' \"{\\\"mountPath\\\":\\\"$mountpoint\\\",\\\"remoteBundlePath\\\":\\\"$bundle\\\",\\\"mode\\\":\\\"directoryBundle\\\"}\"",
  ].join("\n");
}

export function packBundleScript(bundlePath: string, mountPath: string): string {
  return [
    "set -Eeuo pipefail",
    ensureDirectoryBundleToolsScript(),
    `bundle=${shellQuote(bundlePath)}`,
    `mountpoint=${shellQuote(mountPath)}`,
    "test -d \"$mountpoint\"",
    "rm -f \"$bundle\"",
    "sync \"$mountpoint\" 2>/dev/null || sync",
    "tar -C \"$mountpoint\" -cf - . | zstd -T0 -q -o \"$bundle\"",
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
    "umount \"$mountpoint\"",
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
