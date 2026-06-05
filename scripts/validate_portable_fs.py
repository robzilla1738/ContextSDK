#!/usr/bin/env python3
"""Validate portable ext4 filesystem images across fresh E2B sandboxes."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


REMOTE_DATA_IMAGE = "/tmp/portable-data.ext4.img"
REMOTE_ROOTFS_IMAGE = "/tmp/portable-rootfs.ext4.img"


class HarnessError(Exception):
    """A validation failure that is not an E2B capability limitation."""


class CapabilityError(Exception):
    """E2B cannot provide the kernel/device capability needed for loop mounts."""


@dataclass
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    error: str

    @property
    def combined_output(self) -> str:
        return "\n".join(part for part in (self.stdout, self.stderr, self.error) if part)


class RedactingLogger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._secrets = [value for value in (os.environ.get("E2B_API_KEY"),) if value]
        self.path.write_text("", encoding="utf-8")

    def redact(self, text: object) -> str:
        value = "" if text is None else str(text)
        for secret in self._secrets:
            value = value.replace(secret, "<redacted:E2B_API_KEY>")
        value = re.sub(r"e2b_[A-Za-z0-9]+", "<redacted:e2b_api_key>", value)
        home = str(Path.home())
        if home and home != "/":
            value = value.replace(home, "~")
        return value

    def write(self, text: object = "") -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(self.redact(text))

    def section(self, title: str) -> None:
        self.write(f"\n\n===== {title} =====\n")


def run_local_command(
    logger: RedactingLogger,
    title: str,
    args: list[str],
    *,
    timeout: float = 300,
) -> subprocess.CompletedProcess[str]:
    logger.section(title)
    logger.write("$ " + " ".join(args) + "\n")
    result = subprocess.run(
        args,
        check=False,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    logger.write(result.stdout)
    logger.write(result.stderr)
    if result.returncode != 0:
        logger.write(f"\n[exit_code={result.returncode}]\n")
        raise HarnessError(f"{title} failed with exit code {result.returncode}")
    return result


def normalize_result(raw: Any, fallback_exit_code: int = 0) -> CommandResult:
    return CommandResult(
        exit_code=int(getattr(raw, "exit_code", fallback_exit_code) or fallback_exit_code),
        stdout=str(getattr(raw, "stdout", "") or ""),
        stderr=str(getattr(raw, "stderr", "") or ""),
        error=str(getattr(raw, "error", "") or ""),
    )


def normalize_exception(exc: BaseException) -> CommandResult:
    raw = getattr(exc, "result", None) or getattr(exc, "command_result", None) or exc
    result = normalize_result(raw, fallback_exit_code=1)
    if not result.error:
        result.error = str(exc)
    return result


def is_loop_mount_limitation(output: str) -> bool:
    lowered = output.lower()
    markers = (
        "operation not permitted",
        "permission denied",
        "failed to set up loop device",
        "cannot find an unused loop device",
        "no such device",
        "/dev/loop-control",
        "losetup:",
    )
    return any(marker in lowered for marker in markers)


def run_command(
    sandbox: Any,
    logger: RedactingLogger,
    title: str,
    cmd: str,
    *,
    user: str = "root",
    timeout: float = 300,
    allow_failure: bool = False,
    capability_sensitive: bool = False,
) -> CommandResult:
    logger.section(title)
    logger.write(f"$ {cmd}\n")
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    def on_stdout(chunk: str) -> None:
        stdout_chunks.append(chunk)
        logger.write(chunk)

    def on_stderr(chunk: str) -> None:
        stderr_chunks.append(chunk)
        logger.write(chunk)

    try:
        raw = sandbox.commands.run(
            cmd,
            user=user,
            timeout=timeout,
            on_stdout=on_stdout,
            on_stderr=on_stderr,
        )
        result = normalize_result(raw)
    except Exception as exc:  # E2B raises on non-zero command exits.
        result = normalize_exception(exc)
        if stdout_chunks and not result.stdout:
            result.stdout = "".join(stdout_chunks)
        if stderr_chunks and not result.stderr:
            result.stderr = "".join(stderr_chunks)

    if result.exit_code != 0:
        logger.write(f"\n[exit_code={result.exit_code}]\n")
        if capability_sensitive and is_loop_mount_limitation(result.combined_output):
            raise CapabilityError(result.combined_output)
        if not allow_failure:
            raise HarnessError(f"{title} failed with exit code {result.exit_code}")

    return result


def write_remote_script(sandbox: Any, path: str, script: str) -> None:
    sandbox.files.write(path, script.encode("utf-8"))


def run_remote_script(
    sandbox: Any,
    logger: RedactingLogger,
    title: str,
    path: str,
    script: str,
    *,
    timeout: float = 600,
    capability_sensitive: bool = False,
) -> CommandResult:
    write_remote_script(sandbox, path, script)
    return run_command(
        sandbox,
        logger,
        title,
        f"chmod 700 {path} && {path}",
        timeout=timeout,
        capability_sensitive=capability_sensitive,
    )


def read_remote_file(sandbox: Any, remote_path: str, local_path: Path) -> int:
    url = sandbox.download_url(remote_path, user="root", use_signature_expiration=600)
    total = 0
    with httpx.stream("GET", url, timeout=120) as response:
        response.raise_for_status()
        with local_path.open("wb") as handle:
            for chunk in response.iter_bytes():
                handle.write(chunk)
                total += len(chunk)
    return total


def write_remote_file(sandbox: Any, local_path: Path, remote_path: str) -> int:
    url = sandbox.upload_url(remote_path, user="root", use_signature_expiration=600)
    with local_path.open("rb") as handle:
        response = httpx.post(
            url,
            files={"file": (local_path.name, handle, "application/octet-stream")},
            timeout=120,
        )
    response.raise_for_status()
    return local_path.stat().st_size


def probe_script() -> str:
    return shell_script(
        """\
        #!/usr/bin/env bash
        set -u
        echo "## identity"
        id
        echo "## kernel"
        uname -a
        echo "## filesystems"
        cat /proc/filesystems || true
        echo "## loop devices"
        ls -l /dev/loop-control /dev/loop* 2>/dev/null || true
        echo "## command paths"
        for cmd in losetup mount umount mkfs.ext4 e2fsck findmnt truncate sha256sum chroot busybox apt-get; do
          printf "%-12s " "$cmd"
          command -v "$cmd" || true
        done
        echo "## versions"
        losetup --version 2>&1 || true
        mount --version 2>&1 | head -1 || true
        mkfs.ext4 -V 2>&1 | head -2 || true
        e2fsck -V 2>&1 | head -2 || true
        findmnt --version 2>&1 || true
        """
    )


def shell_script(script: str) -> str:
    """Normalize generated shell scripts while keeping heredoc terminators valid."""
    return textwrap.dedent(script).replace("\n        EOF_", "\nEOF_")


def ensure_tools_script() -> str:
    return shell_script(
        """\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        missing=""
        for cmd in losetup mount umount mkfs.ext4 e2fsck findmnt truncate sha256sum chroot; do
          if ! command -v "$cmd" >/dev/null 2>&1; then
            missing="$missing $cmd"
          fi
        done

        if [ -n "$missing" ]; then
          if ! command -v apt-get >/dev/null 2>&1; then
            echo "Missing required commands and apt-get is unavailable:$missing" >&2
            exit 31
          fi
          export DEBIAN_FRONTEND=noninteractive
          apt-get update
          apt-get install -y util-linux e2fsprogs coreutils
        fi

        find_static_busybox() {
          for candidate in /tmp/fs-sdk-busybox-static /bin/busybox /usr/bin/busybox "$(command -v busybox || true)"; do
            if [ -n "$candidate" ] && [ -x "$candidate" ]; then
              ldd_output="$(ldd "$candidate" 2>&1 || true)"
              if printf "%s\n" "$ldd_output" | grep -qi "not a dynamic executable"; then
                printf "%s\n" "$candidate"
                return 0
              fi
            fi
          done
          return 1
        }

        if ! find_static_busybox >/dev/null 2>&1; then
          if ! command -v apt-get >/dev/null 2>&1; then
            echo "static busybox is missing and apt-get is unavailable" >&2
            exit 32
          fi
          export DEBIAN_FRONTEND=noninteractive
          apt-get update
          apt-get install -y busybox-static
        fi

        busybox_path="$(find_static_busybox || true)"
        if [ -z "$busybox_path" ] || [ ! -x "$busybox_path" ]; then
          echo "static busybox is still unavailable after installation attempt" >&2
          exit 33
        fi

        cp "$busybox_path" /tmp/fs-sdk-busybox-static
        chmod 755 /tmp/fs-sdk-busybox-static
        echo "busybox static check: ok (/tmp/fs-sdk-busybox-static from $busybox_path)"
        """
    )


def create_data_image_script(size_mb: int) -> str:
    manifest = {
        "kind": "portable-data",
        "filesystem": "ext4",
        "label": "PORTABLE_DATA",
        "created_in": "sandbox-a",
        "purpose": "detachable user-data filesystem validation for agentic AI applications",
        "agentic_layout": {
            "workspace": "agents/default/workspace",
            "memory": "agents/default/memory",
            "artifacts": "agents/default/artifacts",
            "logs": "agents/default/logs",
            "cache": "agents/default/cache",
            "config": "agents/default/config",
        },
    }
    manifest_json = json.dumps(manifest, indent=2, sort_keys=True)
    return shell_script(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        image="{REMOTE_DATA_IMAGE}"
        mountpoint="/mnt/portable-data"
        loopdev=""

        cleanup() {{
          set +e
          if mountpoint -q "$mountpoint"; then umount "$mountpoint"; fi
          if [ -n "$loopdev" ]; then losetup -d "$loopdev"; fi
        }}
        trap cleanup EXIT

        rm -f "$image"
        mkdir -p "$mountpoint"
        truncate -s {size_mb}M "$image"
        mkfs.ext4 -F -L PORTABLE_DATA "$image"
        loopdev="$(losetup --find --show "$image")"
        mount -t ext4 "$loopdev" "$mountpoint"

        mkdir -p \
          "$mountpoint/documents" \
          "$mountpoint/state" \
          "$mountpoint/agents/default/workspace" \
          "$mountpoint/agents/default/memory" \
          "$mountpoint/agents/default/artifacts" \
          "$mountpoint/agents/default/logs" \
          "$mountpoint/agents/default/cache" \
          "$mountpoint/agents/default/config"
        cat > "$mountpoint/manifest.json" <<'EOF_MANIFEST'
        {manifest_json}
EOF_MANIFEST
        printf "hello from sandbox A\\n" > "$mountpoint/documents/hello.txt"
        printf "portable-data=true\\n" > "$mountpoint/state/settings.txt"
        printf "goal=validate portable agent data volume\\nstatus=created-in-sandbox-a\\n" > "$mountpoint/agents/default/memory/session.md"
        printf '{{"task":"portable-fs","sandbox":"A","status":"checkpointed"}}\\n' > "$mountpoint/agents/default/workspace/task-state.json"
        printf "artifact from sandbox A\\n" > "$mountpoint/agents/default/artifacts/result.txt"
        printf "sandbox A agent log line\\n" > "$mountpoint/agents/default/logs/agent.log"
        printf '{{"model_cache_policy":"portable","safe_to_move":true}}\\n' > "$mountpoint/agents/default/config/runtime.json"
        chown -R 1000:1000 "$mountpoint/agents"
        chmod -R u+rwX,g+rwX "$mountpoint/agents"
        (cd "$mountpoint" && sha256sum \
          documents/hello.txt \
          state/settings.txt \
          manifest.json \
          agents/default/memory/session.md \
          agents/default/workspace/task-state.json \
          agents/default/artifacts/result.txt \
          agents/default/logs/agent.log \
          agents/default/config/runtime.json \
          > manifest.sha256)

        sync
        findmnt --target "$mountpoint"
        umount "$mountpoint"
        losetup -d "$loopdev"
        loopdev=""
        e2fsck -fn "$image"
        sha256sum "$image"
        """
    )


def verify_data_image_script() -> str:
    return shell_script(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        image="{REMOTE_DATA_IMAGE}"
        mountpoint="/mnt/portable-data"
        loopdev=""

        cleanup() {{
          set +e
          if mountpoint -q "$mountpoint"; then umount "$mountpoint"; fi
          if [ -n "$loopdev" ]; then losetup -d "$loopdev"; fi
        }}
        trap cleanup EXIT

        test -f "$image"
        mkdir -p "$mountpoint"
        loopdev="$(losetup --find --show "$image")"
        mount -t ext4 "$loopdev" "$mountpoint"

        grep -q '"label": "PORTABLE_DATA"' "$mountpoint/manifest.json"
        grep -q "hello from sandbox A" "$mountpoint/documents/hello.txt"
        grep -q "status=created-in-sandbox-a" "$mountpoint/agents/default/memory/session.md"
        grep -q '"status":"checkpointed"' "$mountpoint/agents/default/workspace/task-state.json"
        test -w "$mountpoint/agents/default/workspace"
        test -w "$mountpoint/agents/default/memory"
        test -w "$mountpoint/agents/default/artifacts"
        test -w "$mountpoint/agents/default/logs"
        test -w "$mountpoint/agents/default/cache"
        test -w "$mountpoint/agents/default/config"
        (cd "$mountpoint" && sha256sum -c manifest.sha256)
        printf "reattached in sandbox B at %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$mountpoint/state/reattach-marker.txt"
        printf "sandbox B resumed agent state\\n" >> "$mountpoint/agents/default/logs/agent.log"
        printf '{{"task":"portable-fs","sandbox":"B","status":"resumed"}}\\n' > "$mountpoint/agents/default/workspace/resume-state.json"

        sync
        findmnt --target "$mountpoint"
        umount "$mountpoint"
        losetup -d "$loopdev"
        loopdev=""
        e2fsck -fn "$image"
        sha256sum "$image"
        """
    )


def verify_local_to_vm_data_image_script() -> str:
    return shell_script(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        image="{REMOTE_DATA_IMAGE}"
        mountpoint="/mnt/portable-data"
        loopdev=""

        cleanup() {{
          set +e
          if mountpoint -q "$mountpoint"; then umount "$mountpoint"; fi
          if [ -n "$loopdev" ]; then losetup -d "$loopdev"; fi
        }}
        trap cleanup EXIT

        test -f "$image"
        mkdir -p "$mountpoint"
        loopdev="$(losetup --find --show "$image")"
        mount -t ext4 "$loopdev" "$mountpoint"

        grep -q '"label": "PORTABLE_DATA"' "$mountpoint/manifest.json"
        grep -q '"origin": "local-macos"' "$mountpoint/manifest.json"
        grep -q "created on local macOS" "$mountpoint/documents/hello.txt"
        grep -q "status=created-on-local-macos" "$mountpoint/agents/default/memory/session.md"
        (cd "$mountpoint" && sha256sum -c manifest.sha256)

        test -w "$mountpoint/agents/default/workspace"
        test -w "$mountpoint/agents/default/memory"
        if command -v setpriv >/dev/null 2>&1; then
          setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "echo non-root-agent-write-ok > '$mountpoint/agents/default/workspace/vm-agent-write.txt'"
        else
          chmod 777 "$mountpoint/agents/default/workspace"
          su nobody -s /bin/sh -c "echo non-root-agent-write-ok > '$mountpoint/agents/default/workspace/vm-agent-write.txt'"
        fi
        grep -q "non-root-agent-write-ok" "$mountpoint/agents/default/workspace/vm-agent-write.txt"
        printf "reattached in E2B VM at %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$mountpoint/state/vm-reattach-marker.txt"

        sync
        findmnt --target "$mountpoint"
        umount "$mountpoint"
        losetup -d "$loopdev"
        loopdev=""
        e2fsck -fn "$image"
        sha256sum "$image"
        """
    )


def write_text(path: Path, value: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    if mode is not None:
        path.chmod(mode)


def prepare_local_agent_data_tree(staging_dir: Path) -> None:
    manifest = {
        "kind": "portable-data",
        "filesystem": "ext4",
        "label": "PORTABLE_DATA",
        "origin": "local-macos",
        "purpose": "local Mac to Linux VM portable agent data filesystem validation",
        "agentic_layout": {
            "workspace": "agents/default/workspace",
            "memory": "agents/default/memory",
            "artifacts": "agents/default/artifacts",
            "logs": "agents/default/logs",
            "cache": "agents/default/cache",
            "config": "agents/default/config",
        },
    }
    paths = [
        "documents",
        "state",
        "agents/default/workspace",
        "agents/default/memory",
        "agents/default/artifacts",
        "agents/default/logs",
        "agents/default/cache",
        "agents/default/config",
    ]
    for relative in paths:
        directory = staging_dir / relative
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o777 if relative.startswith("agents/default") else 0o755)

    write_text(staging_dir / "manifest.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n", 0o644)
    write_text(staging_dir / "documents/hello.txt", "created on local macOS\n", 0o644)
    write_text(staging_dir / "state/settings.txt", "portable-data=true\norigin=local-macos\n", 0o644)
    write_text(
        staging_dir / "agents/default/memory/session.md",
        "goal=validate local-to-vm portable agent data volume\nstatus=created-on-local-macos\n",
        0o666,
    )
    write_text(
        staging_dir / "agents/default/workspace/task-state.json",
        '{"task":"local-to-vm-portable-fs","origin":"local-macos","status":"checkpointed"}\n',
        0o666,
    )
    write_text(staging_dir / "agents/default/artifacts/result.txt", "artifact from local macOS\n", 0o666)
    write_text(staging_dir / "agents/default/logs/agent.log", "local macOS agent log line\n", 0o666)
    write_text(
        staging_dir / "agents/default/config/runtime.json",
        '{"model_cache_policy":"portable","safe_to_move":true,"origin":"local-macos"}\n',
        0o666,
    )

    checksum_paths = [
        "documents/hello.txt",
        "state/settings.txt",
        "manifest.json",
        "agents/default/memory/session.md",
        "agents/default/workspace/task-state.json",
        "agents/default/artifacts/result.txt",
        "agents/default/logs/agent.log",
        "agents/default/config/runtime.json",
    ]
    lines = []
    for relative in checksum_paths:
        import hashlib

        digest = hashlib.sha256((staging_dir / relative).read_bytes()).hexdigest()
        lines.append(f"{digest}  {relative}\n")
    write_text(staging_dir / "manifest.sha256", "".join(lines), 0o644)


def find_local_e2fs_tool(name: str) -> str | None:
    candidates = [
        shutil.which(name),
        f"/opt/homebrew/opt/e2fsprogs/sbin/{name}",
        f"/opt/homebrew/opt/e2fsprogs/bin/{name}",
        f"/usr/local/opt/e2fsprogs/sbin/{name}",
        f"/usr/local/opt/e2fsprogs/bin/{name}",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def create_local_data_image(
    logger: RedactingLogger,
    image_path: Path,
    staging_dir: Path,
    *,
    size_mb: int,
    timeout: float,
) -> None:
    mkfs = find_local_e2fs_tool("mkfs.ext4") or find_local_e2fs_tool("mke2fs")
    e2fsck = find_local_e2fs_tool("e2fsck")
    if not mkfs or not e2fsck:
        raise HarnessError(
            "Local e2fsprogs tools are missing. Install with: brew install e2fsprogs"
        )

    if image_path.exists():
        image_path.unlink()
    staging_dir.mkdir(parents=True, exist_ok=True)
    prepare_local_agent_data_tree(staging_dir)
    run_local_command(logger, "create sparse local image", ["truncate", "-s", f"{size_mb}M", str(image_path)], timeout=timeout)
    run_local_command(
        logger,
        "format local ext4 image from staging tree",
        [mkfs, "-F", "-t", "ext4", "-L", "PORTABLE_DATA", "-d", str(staging_dir), str(image_path)],
        timeout=timeout,
    )
    run_local_command(logger, "local e2fsck", [e2fsck, "-fn", str(image_path)], timeout=timeout)


def create_rootfs_image_script(size_mb: int) -> str:
    manifest = {
        "kind": "portable-rootfs",
        "filesystem": "ext4",
        "label": "PORTABLE_ROOTFS",
        "created_in": "sandbox-a",
        "purpose": "minimal chrootable rootfs validation for agentic AI applications",
        "agent_user": "agent",
        "agent_uid": 1000,
    }
    manifest_json = json.dumps(manifest, indent=2, sort_keys=True)
    return shell_script(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        image="{REMOTE_ROOTFS_IMAGE}"
        mountpoint="/mnt/portable-rootfs"
        loopdev=""

        cleanup() {{
          set +e
          if mountpoint -q "$mountpoint"; then umount "$mountpoint"; fi
          if [ -n "$loopdev" ]; then losetup -d "$loopdev"; fi
        }}
        trap cleanup EXIT

        rm -f "$image"
        mkdir -p "$mountpoint"
        truncate -s {size_mb}M "$image"
        mkfs.ext4 -F -L PORTABLE_ROOTFS "$image"
        loopdev="$(losetup --find --show "$image")"
        mount -t ext4 "$loopdev" "$mountpoint"

        mkdir -p "$mountpoint"/{{bin,etc,dev,proc,sys,tmp,home/agent,var/lib/agent,var/cache/agent,var/log/agent,run,workspace}}
        mkdir -p "$mountpoint"/var/lib/agent/{{memory,state,artifacts,config}}
        chmod 1777 "$mountpoint/tmp"
        cp /tmp/fs-sdk-busybox-static "$mountpoint/bin/busybox"
        chmod 755 "$mountpoint/bin/busybox"
        for app in sh cat echo ls mkdir pwd test true false uname date id touch whoami; do
          ln -sf busybox "$mountpoint/bin/$app"
        done

        cat > "$mountpoint/etc/os-release" <<'EOF_OS'
        NAME="FS-SDK Portable Rootfs"
        ID=fs-sdk-portable-rootfs
        VERSION_ID=0.1.0
        PRETTY_NAME="FS-SDK Portable Rootfs 0.1.0"
        EOF_OS
        cat > "$mountpoint/etc/passwd" <<'EOF_PASSWD'
        root:x:0:0:root:/root:/bin/sh
        agent:x:1000:1000:agent:/home/agent:/bin/sh
EOF_PASSWD
        cat > "$mountpoint/etc/group" <<'EOF_GROUP'
        root:x:0:
        agent:x:1000:
EOF_GROUP
        cat > "$mountpoint/manifest.json" <<'EOF_MANIFEST'
        {manifest_json}
        EOF_MANIFEST
        printf "rootfs created in sandbox A\\n" > "$mountpoint/home/agent/README.txt"
        printf "goal=validate portable agent rootfs\\nstatus=created-in-sandbox-a\\n" > "$mountpoint/var/lib/agent/memory/session.md"
        printf '{{"task":"portable-rootfs","sandbox":"A","status":"checkpointed"}}\\n' > "$mountpoint/workspace/task-state.json"
        printf '{{"agent_runtime":"portable-rootfs","safe_to_move":true}}\\n' > "$mountpoint/var/lib/agent/config/runtime.json"
        chown -R 1000:1000 "$mountpoint/home/agent" "$mountpoint/var/lib/agent" "$mountpoint/var/cache/agent" "$mountpoint/var/log/agent" "$mountpoint/workspace"
        chmod -R u+rwX,g+rwX "$mountpoint/home/agent" "$mountpoint/var/lib/agent" "$mountpoint/var/cache/agent" "$mountpoint/var/log/agent" "$mountpoint/workspace"
        (cd "$mountpoint" && sha256sum \
          bin/busybox \
          etc/os-release \
          etc/passwd \
          etc/group \
          manifest.json \
          home/agent/README.txt \
          var/lib/agent/memory/session.md \
          var/lib/agent/config/runtime.json \
          workspace/task-state.json \
          > manifest.sha256)

        chroot "$mountpoint" /bin/sh -c 'cat /etc/os-release; echo rootfs-ok'
        chroot --userspec=1000:1000 "$mountpoint" /bin/sh -c 'test -w /workspace && test -w /var/lib/agent/memory && echo agent-user-ok > /var/lib/agent/state/non-root-check.txt'
        sync
        findmnt --target "$mountpoint"
        umount "$mountpoint"
        losetup -d "$loopdev"
        loopdev=""
        e2fsck -fn "$image"
        sha256sum "$image"
        """
    )


def verify_rootfs_image_script() -> str:
    return shell_script(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        image="{REMOTE_ROOTFS_IMAGE}"
        mountpoint="/mnt/portable-rootfs"
        loopdev=""

        cleanup() {{
          set +e
          if mountpoint -q "$mountpoint"; then umount "$mountpoint"; fi
          if [ -n "$loopdev" ]; then losetup -d "$loopdev"; fi
        }}
        trap cleanup EXIT

        test -f "$image"
        mkdir -p "$mountpoint"
        loopdev="$(losetup --find --show "$image")"
        mount -t ext4 "$loopdev" "$mountpoint"

        grep -q '"label": "PORTABLE_ROOTFS"' "$mountpoint/manifest.json"
        grep -q "status=created-in-sandbox-a" "$mountpoint/var/lib/agent/memory/session.md"
        grep -q '"status":"checkpointed"' "$mountpoint/workspace/task-state.json"
        (cd "$mountpoint" && sha256sum -c manifest.sha256)
        chroot "$mountpoint" /bin/sh -c 'cat /etc/os-release; echo rootfs-ok'
        chroot --userspec=1000:1000 "$mountpoint" /bin/sh -c 'test -w /workspace && test -w /var/lib/agent/state && echo agent-user-ok && echo resumed-in-sandbox-b > /workspace/resume-state.txt'
        printf "reattached in sandbox B at %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$mountpoint/home/agent/reattach-marker.txt"

        sync
        findmnt --target "$mountpoint"
        umount "$mountpoint"
        losetup -d "$loopdev"
        loopdev=""
        e2fsck -fn "$image"
        sha256sum "$image"
        """
    )


def make_artifact_dir(root: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_dir = root / "artifacts" / f"run-{stamp}"
    artifact_dir.mkdir(parents=True, exist_ok=False)
    return artifact_dir


def load_e2b_sandbox_class() -> Any:
    try:
        from e2b import Sandbox
    except ImportError as exc:
        raise HarnessError(
            "The e2b package is not installed. Run: python -m pip install -e ."
        ) from exc
    return Sandbox


def create_sandbox(Sandbox: Any, role: str, timeout: int) -> Any:
    return Sandbox.create(
        timeout=timeout,
        secure=True,
        metadata={"purpose": "fs-sdk-portable-filesystem-validation", "role": role},
    )


def sandbox_id(sandbox: Any) -> str:
    return str(getattr(sandbox, "sandbox_id", "") or getattr(sandbox, "sandboxId", "") or "")


def write_summary(path: Path, summary: dict[str, Any], logger_a: RedactingLogger, logger_b: RedactingLogger) -> None:
    redacted = json.loads(logger_b.redact(logger_a.redact(json.dumps(summary, indent=2, sort_keys=True))))
    path.write_text(json.dumps(redacted, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)
    for log_path in (logger_a.path, logger_b.path, path):
        text = log_path.read_text(encoding="utf-8")
        redacted_text = logger_a.redact(text)
        if redacted_text != text:
            log_path.write_text(redacted_text, encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate detachable ext4 user-data and minimal rootfs images across two E2B sandboxes."
    )
    parser.add_argument("--data-size-mb", type=int, default=64, help="Size of the user-data ext4 image.")
    parser.add_argument("--rootfs-size-mb", type=int, default=128, help="Size of the rootfs ext4 image.")
    parser.add_argument("--sandbox-timeout", type=int, default=1800, help="E2B sandbox lifetime in seconds.")
    parser.add_argument("--command-timeout", type=float, default=900, help="Remote command timeout in seconds.")
    parser.add_argument("--keep-sandboxes", action="store_true", help="Do not kill sandboxes at the end.")
    parser.add_argument(
        "--local-to-vm",
        action="store_true",
        help="Create the data filesystem image locally on this machine, then upload and mount it in one fresh E2B VM.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    repo_root = Path(__file__).resolve().parents[1]
    artifact_dir = make_artifact_dir(repo_root)
    logger_a = RedactingLogger(artifact_dir / ("local.log" if args.local_to_vm else "sandbox-a.log"))
    logger_b = RedactingLogger(artifact_dir / ("vm.log" if args.local_to_vm else "sandbox-b.log"))
    summary_path = artifact_dir / "summary.json"
    data_image = artifact_dir / "portable-data.ext4.img"
    vm_data_image = artifact_dir / "portable-data.after-vm.ext4.img"
    rootfs_image = artifact_dir / "portable-rootfs.ext4.img"

    summary: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "mode": "local-to-vm" if args.local_to_vm else "sandbox-to-sandbox",
        "artifact_dir": str(artifact_dir),
        "passed": False,
        "capability_limitation": False,
        "sandbox_a_id": None,
        "sandbox_b_id": None,
        "data_image": {"passed": False, "local_path": str(data_image)},
        "rootfs_image": {"passed": False, "local_path": str(rootfs_image)},
        "agentic_ai_application": {
            "passed": False,
            "checks": [
                "portable agent workspace",
                "portable agent memory/state",
                "portable artifacts/logs/cache/config",
                "non-root agent user in rootfs",
            ],
        },
        "logs": (
            {"local": str(logger_a.path), "vm": str(logger_b.path)}
            if args.local_to_vm
            else {"sandbox_a": str(logger_a.path), "sandbox_b": str(logger_b.path)}
        ),
    }

    if not os.environ.get("E2B_API_KEY"):
        summary["error"] = "E2B_API_KEY is not set in the environment."
        write_summary(summary_path, summary, logger_a, logger_b)
        print(f"E2B_API_KEY is not set. Wrote summary to {summary_path}")
        return 2

    sandbox_a = None
    sandbox_b = None

    try:
        Sandbox = load_e2b_sandbox_class()
        if args.local_to_vm:
            staging_dir = artifact_dir / "local-staging"
            create_local_data_image(
                logger_a,
                data_image,
                staging_dir,
                size_mb=args.data_size_mb,
                timeout=args.command_timeout,
            )
            summary["data_image"]["created_on_local_machine"] = True
            summary["data_image"]["bytes_after_local_create"] = data_image.stat().st_size
            summary["sandbox_a_id"] = "local-macos"

            sandbox_b = create_sandbox(Sandbox, "local-to-vm", args.sandbox_timeout)
            summary["sandbox_b_id"] = sandbox_id(sandbox_b)
            run_remote_script(sandbox_b, logger_b, "preflight probe", "/tmp/fs-sdk-probe.sh", probe_script(), timeout=120)
            run_remote_script(sandbox_b, logger_b, "ensure required tools", "/tmp/fs-sdk-ensure-tools.sh", ensure_tools_script(), timeout=args.command_timeout)
            summary["data_image"]["uploaded_bytes_to_vm"] = write_remote_file(sandbox_b, data_image, REMOTE_DATA_IMAGE)
            run_remote_script(
                sandbox_b,
                logger_b,
                "verify local data image in VM",
                "/tmp/fs-sdk-verify-local-to-vm-data.sh",
                verify_local_to_vm_data_image_script(),
                timeout=args.command_timeout,
                capability_sensitive=True,
            )
            summary["data_image"]["bytes_after_vm"] = read_remote_file(sandbox_b, REMOTE_DATA_IMAGE, vm_data_image)
            summary["data_image"]["updated_local_path"] = str(vm_data_image)
            summary["data_image"]["passed"] = True
            summary["rootfs_image"]["skipped"] = True
            summary["agentic_ai_application"]["passed"] = True
            summary["passed"] = True
            summary["finished_at"] = datetime.now(timezone.utc).isoformat()
            write_summary(summary_path, summary, logger_a, logger_b)
            print(f"Local-to-VM validation passed. Artifacts: {artifact_dir}")
            return 0

        sandbox_a = create_sandbox(Sandbox, "sandbox-a", args.sandbox_timeout)
        sandbox_b = create_sandbox(Sandbox, "sandbox-b", args.sandbox_timeout)
        summary["sandbox_a_id"] = sandbox_id(sandbox_a)
        summary["sandbox_b_id"] = sandbox_id(sandbox_b)

        run_remote_script(sandbox_a, logger_a, "preflight probe", "/tmp/fs-sdk-probe.sh", probe_script(), timeout=120)
        run_remote_script(sandbox_b, logger_b, "preflight probe", "/tmp/fs-sdk-probe.sh", probe_script(), timeout=120)
        run_remote_script(sandbox_a, logger_a, "ensure required tools", "/tmp/fs-sdk-ensure-tools.sh", ensure_tools_script(), timeout=args.command_timeout)
        run_remote_script(sandbox_b, logger_b, "ensure required tools", "/tmp/fs-sdk-ensure-tools.sh", ensure_tools_script(), timeout=args.command_timeout)

        run_remote_script(
            sandbox_a,
            logger_a,
            "create portable data image",
            "/tmp/fs-sdk-create-data.sh",
            create_data_image_script(args.data_size_mb),
            timeout=args.command_timeout,
            capability_sensitive=True,
        )
        summary["data_image"]["created_in_sandbox_a"] = True
        summary["data_image"]["bytes_after_sandbox_a"] = read_remote_file(sandbox_a, REMOTE_DATA_IMAGE, data_image)
        summary["data_image"]["uploaded_bytes_to_sandbox_b"] = write_remote_file(sandbox_b, data_image, REMOTE_DATA_IMAGE)
        run_remote_script(
            sandbox_b,
            logger_b,
            "verify portable data image",
            "/tmp/fs-sdk-verify-data.sh",
            verify_data_image_script(),
            timeout=args.command_timeout,
            capability_sensitive=True,
        )
        summary["data_image"]["bytes_after_sandbox_b"] = read_remote_file(sandbox_b, REMOTE_DATA_IMAGE, data_image)
        summary["data_image"]["passed"] = True

        run_remote_script(
            sandbox_a,
            logger_a,
            "create portable rootfs image",
            "/tmp/fs-sdk-create-rootfs.sh",
            create_rootfs_image_script(args.rootfs_size_mb),
            timeout=args.command_timeout,
            capability_sensitive=True,
        )
        summary["rootfs_image"]["created_in_sandbox_a"] = True
        summary["rootfs_image"]["bytes_after_sandbox_a"] = read_remote_file(sandbox_a, REMOTE_ROOTFS_IMAGE, rootfs_image)
        summary["rootfs_image"]["uploaded_bytes_to_sandbox_b"] = write_remote_file(sandbox_b, rootfs_image, REMOTE_ROOTFS_IMAGE)
        run_remote_script(
            sandbox_b,
            logger_b,
            "verify portable rootfs image",
            "/tmp/fs-sdk-verify-rootfs.sh",
            verify_rootfs_image_script(),
            timeout=args.command_timeout,
            capability_sensitive=True,
        )
        summary["rootfs_image"]["bytes_after_sandbox_b"] = read_remote_file(sandbox_b, REMOTE_ROOTFS_IMAGE, rootfs_image)
        summary["rootfs_image"]["passed"] = True

        summary["passed"] = bool(summary["data_image"]["passed"] and summary["rootfs_image"]["passed"])
        summary["agentic_ai_application"]["passed"] = summary["passed"]
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_summary(summary_path, summary, logger_a, logger_b)
        print(f"Validation passed. Artifacts: {artifact_dir}")
        return 0
    except CapabilityError as exc:
        summary["capability_limitation"] = True
        summary["error"] = "e2b loop mount unsupported"
        summary["capability_probe_output"] = logger_a.redact(str(exc))
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_summary(summary_path, summary, logger_a, logger_b)
        print(f"E2B loop mount unsupported. Wrote summary to {summary_path}")
        return 20
    except HarnessError as exc:
        summary["error"] = str(exc)
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_summary(summary_path, summary, logger_a, logger_b)
        print(f"Validation failed: {exc}. Wrote summary to {summary_path}")
        return 1
    except Exception as exc:
        summary["error"] = f"{type(exc).__name__}: {exc}"
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_summary(summary_path, summary, logger_a, logger_b)
        print(f"Validation failed unexpectedly. Wrote summary to {summary_path}")
        return 1
    finally:
        if not args.keep_sandboxes:
            for sandbox, logger, label in ((sandbox_a, logger_a, "kill sandbox A"), (sandbox_b, logger_b, "kill sandbox B")):
                if sandbox is None:
                    continue
                try:
                    logger.section(label)
                    logger.write(str(sandbox.kill()))
                    logger.write("\n")
                except Exception as exc:
                    logger.write(f"Failed to kill sandbox: {logger.redact(exc)}\n")


if __name__ == "__main__":
    raise SystemExit(main())
