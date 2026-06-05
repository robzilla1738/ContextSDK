#!/usr/bin/env python3
"""Create a synthetic portable context image and mount it in a fresh E2B VM.

The generated VM is meant for blind retrieval tests with another AI. The mounted
filesystem contains synthetic context only; the answer key is kept locally in
the artifact directory and is not uploaded to the VM.
"""

from __future__ import annotations

import argparse
import hashlib
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


REMOTE_IMAGE = "/tmp/contextsdk-synthetic-context.ext4.img"
MOUNT_PATH = "/mnt/contextsdk/synthetic-context"


class TrialError(Exception):
    """Synthetic trial setup failed."""


@dataclass(frozen=True)
class RetrievalQuestion:
    id: str
    prompt: str
    expected: str
    evidence: list[str]


QUESTIONS = [
    RetrievalQuestion(
        id="q1_launch_blocker",
        prompt="What is the single gating blocker for Project Meridian's Friday launch decision?",
        expected="The Friday launch is blocked until the vendor SOC 2 bridge letter is received from Northwind Data Trust.",
        evidence=[
            "/memory/projects/meridian/decision-log.md",
            "/workspace/projects/meridian/launch-checklist.md",
        ],
    ),
    RetrievalQuestion(
        id="q2_customer_escalation",
        prompt="Which customer escalation should be handled first, and what exact promise was made?",
        expected="Handle HelioBank first; the promised update is a written mitigation plan by 2026-06-09 17:00 UTC.",
        evidence=[
            "/workspace/customers/escalations.md",
            "/memory/people/customer-contacts.md",
        ],
    ),
    RetrievalQuestion(
        id="q3_preferred_delivery",
        prompt="How does this employee prefer executive updates to be delivered?",
        expected="Use a short bullets-first format: decision, risk, next action, owner; avoid long narrative unless explicitly requested.",
        evidence=[
            "/memory/preferences/communication.md",
        ],
    ),
    RetrievalQuestion(
        id="q4_artifact_location",
        prompt="Where is the latest generated board summary artifact, and what is its checksum prefix?",
        expected="It is at /artifacts/reports/board-summary-2026-06-03.md; use /.contextsdk/index.json for the actual sha256 prefix.",
        evidence=[
            "/artifacts/reports/board-summary-2026-06-03.md",
            "/.contextsdk/index.json",
        ],
    ),
    RetrievalQuestion(
        id="q5_agent_instruction",
        prompt="What instruction should the agent follow before modifying infrastructure files?",
        expected="Read /config/change-control.json and require an approval note when the change touches production, billing, or customer data paths.",
        evidence=[
            "/config/agent-policy.md",
            "/config/change-control.json",
        ],
    ),
]


class RedactingLogger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._secrets = [value for value in (os.environ.get("E2B_API_KEY"),) if value]
        self.path.write_text("", encoding="utf-8")

    def redact(self, value: object) -> str:
        text = "" if value is None else str(value)
        for secret in self._secrets:
            text = text.replace(secret, "<redacted:E2B_API_KEY>")
        return re.sub(r"e2b_[A-Za-z0-9]+", "<redacted:e2b_api_key>", text)

    def write(self, value: object = "") -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(self.redact(value))

    def section(self, title: str) -> None:
        self.write(f"\n\n===== {title} =====\n")


def shell_script(script: str) -> str:
    return textwrap.dedent(script).replace("\n        EOF_", "\nEOF_")


def write_text(path: Path, value: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(mode)


def write_json(path: Path, value: Any, mode: int = 0o644) -> None:
    write_text(path, json.dumps(value, indent=2, sort_keys=True) + "\n", mode)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_tool(name: str) -> str | None:
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


def run_local(logger: RedactingLogger, title: str, args: list[str], timeout: float = 600) -> None:
    logger.section(title)
    logger.write("$ " + " ".join(args) + "\n")
    result = subprocess.run(args, check=False, text=True, capture_output=True, timeout=timeout)
    logger.write(result.stdout)
    logger.write(result.stderr)
    if result.returncode != 0:
        raise TrialError(f"{title} failed with exit code {result.returncode}")


def prepare_synthetic_tree(staging: Path) -> dict[str, Any]:
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, mode=0o700)

    roots = ["workspace", "memory", "artifacts", "logs", "cache", "config", ".contextsdk"]
    for root in roots:
        (staging / root).mkdir(parents=True, exist_ok=True)

    write_text(
        staging / "memory/preferences/communication.md",
        """# Communication Preferences

- Start executive updates with four bullets: decision, risk, next action, owner.
- Keep status notes below 120 words unless the requester asks for detail.
- Avoid long narrative in leadership updates.
""",
    )
    write_text(
        staging / "memory/projects/meridian/decision-log.md",
        """# Project Meridian Decision Log

2026-06-01: Approved limited beta for two internal teams.
2026-06-02: Deferred customer launch until legal validates the vendor packet.
2026-06-03: Friday launch remains blocked until Northwind Data Trust sends the SOC 2 bridge letter.
""",
    )
    write_text(
        staging / "memory/people/customer-contacts.md",
        """# Customer Contacts

- HelioBank: Mara Voss, VP Operations, prefers UTC timestamps and written mitigation plans.
- Kestrel Health: Anika Sato, Security Review, prefers evidence bundles.
- PortBlue Logistics: Tomas Reed, Data Platform, prefers direct Slack summaries.
""",
    )
    write_text(
        staging / "workspace/projects/meridian/launch-checklist.md",
        """# Meridian Launch Checklist

Ready:
- Load test replay passed.
- Internal data retention review passed.

Blocked:
- Waiting on Northwind Data Trust SOC 2 bridge letter.

Decision:
- Do not approve Friday launch until the bridge letter is received and attached to the evidence packet.
""",
    )
    write_text(
        staging / "workspace/customers/escalations.md",
        """# Active Escalations

Priority 1: HelioBank
- Issue: export latency regression in compliance workspace.
- Promise: written mitigation plan by 2026-06-09 17:00 UTC.

Priority 2: Kestrel Health
- Issue: requested audit evidence for sandbox retention behavior.
- Promise: evidence bundle by next weekly review.
""",
    )
    board_summary = """# Board Summary - 2026-06-03

Decision: keep Project Meridian in controlled beta.
Risk: vendor assurance packet is incomplete.
Next action: legal tracks Northwind Data Trust bridge letter.
Owner: Priya Nair.
"""
    write_text(staging / "artifacts/reports/board-summary-2026-06-03.md", board_summary)
    write_text(
        staging / "config/agent-policy.md",
        """# Agent Policy

Before modifying infrastructure files, read /config/change-control.json.
If a change touches production, billing, or customer data paths, require an approval note.
""",
    )
    write_json(
        staging / "config/change-control.json",
        {
            "approval_required_for": ["production", "billing", "customer-data"],
            "approval_note_required": True,
            "policy_owner": "platform-governance",
        },
    )
    write_text(staging / "logs/session-2026-06-03.log", "synthetic context initialized\n")
    write_text(staging / "workspace/README.md", "This is a synthetic persistent agent context volume.\n")

    file_entries = []
    for path in sorted(staging.rglob("*")):
        if path.is_file():
            relative = "/" + path.relative_to(staging).as_posix()
            file_entries.append({
                "path": relative,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            })

    index = {
        "contextId": "synthetic-enterprise-context",
        "generation": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "files": file_entries,
    }
    write_json(staging / ".contextsdk/index.json", index)

    board_entry = next(entry for entry in file_entries if entry["path"] == "/artifacts/reports/board-summary-2026-06-03.md")
    questions = []
    for question in QUESTIONS:
        record = question.__dict__.copy()
        if question.id == "q4_artifact_location":
            record["expected"] = (
                "It is at /artifacts/reports/board-summary-2026-06-03.md "
                f"and its sha256 starts with {board_entry['sha256'][:12]}."
            )
        questions.append(record)

    return {
        "questions": questions,
        "note": "This file is local only. Do not upload it to the VM if you want a blind retrieval test.",
    }


def create_ext4_image(logger: RedactingLogger, image_path: Path, staging: Path, size_mb: int) -> None:
    mkfs = find_tool("mkfs.ext4") or find_tool("mke2fs")
    e2fsck = find_tool("e2fsck")
    if not mkfs or not e2fsck:
        raise TrialError("Missing local e2fsprogs. Install with: brew install e2fsprogs")
    image_path.unlink(missing_ok=True)
    run_local(logger, "create sparse image", ["truncate", "-s", f"{size_mb}M", str(image_path)])
    run_local(logger, "format ext4 image", [mkfs, "-F", "-t", "ext4", "-L", "CTX_SYNTH", "-d", str(staging), str(image_path)])
    run_local(logger, "validate ext4 image", [e2fsck, "-fn", str(image_path)])


def load_e2b_sandbox_class() -> Any:
    try:
        from e2b import Sandbox
    except ImportError as exc:
        raise TrialError("The e2b package is not installed. Run: python -m pip install -e .") from exc
    return Sandbox


def sandbox_id(sandbox: Any) -> str:
    return str(getattr(sandbox, "sandbox_id", "") or getattr(sandbox, "sandboxId", "") or "")


def run_remote(
    sandbox: Any,
    logger: RedactingLogger,
    title: str,
    command: str,
    *,
    timeout: float = 600,
) -> str:
    logger.section(title)
    logger.write("$ " + command + "\n")
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    def on_stdout(chunk: str) -> None:
        stdout_chunks.append(chunk)
        logger.write(chunk)

    def on_stderr(chunk: str) -> None:
        stderr_chunks.append(chunk)
        logger.write(chunk)

    try:
        result = sandbox.commands.run(command, user="root", timeout=timeout, on_stdout=on_stdout, on_stderr=on_stderr)
        exit_code = int(getattr(result, "exit_code", 0) or 0)
        stdout = str(getattr(result, "stdout", "") or "".join(stdout_chunks))
        stderr = str(getattr(result, "stderr", "") or "".join(stderr_chunks))
    except Exception as exc:
        raw = getattr(exc, "result", None) or getattr(exc, "command_result", None) or exc
        exit_code = int(getattr(raw, "exit_code", 1) or 1)
        stdout = str(getattr(raw, "stdout", "") or "".join(stdout_chunks))
        stderr = str(getattr(raw, "stderr", "") or "".join(stderr_chunks) or exc)
    if exit_code != 0:
        logger.write(f"\n[exit_code={exit_code}]\n")
        raise TrialError(f"{title} failed with exit code {exit_code}: {stderr.strip()}")
    return stdout


def write_remote_script(sandbox: Any, path: str, script: str) -> None:
    sandbox.files.write(path, script.encode("utf-8"))


def upload_raw(sandbox: Any, logger: RedactingLogger, local_path: Path, remote_path: str) -> int:
    logger.section("upload raw image")
    logger.write(f"local={local_path}\nremote={remote_path}\nbytes={local_path.stat().st_size}\n")
    url = sandbox.upload_url(remote_path, user="root", use_signature_expiration=600)
    with local_path.open("rb") as handle:
        response = httpx.post(
            url,
            files={"file": (local_path.name, handle, "application/octet-stream")},
            timeout=httpx.Timeout(connect=60, read=600, write=600, pool=60),
        )
    response.raise_for_status()
    logger.write(f"status={response.status_code}\n")
    return local_path.stat().st_size


def mount_script() -> str:
    return shell_script(
        f"""\
        #!/usr/bin/env bash
        set -Eeuo pipefail

        image={REMOTE_IMAGE!r}
        mountpoint={MOUNT_PATH!r}

        command -v losetup >/dev/null || (apt-get update && apt-get install -y util-linux e2fsprogs coreutils)
        command -v e2fsck >/dev/null || (apt-get update && apt-get install -y e2fsprogs)

        mkdir -p "$mountpoint"
        if ! mountpoint -q "$mountpoint"; then
          e2fsck -fn "$image" >/tmp/contextsdk-e2fsck.txt
        fi
        if ! mountpoint -q "$mountpoint"; then
          loopdev="$(losetup --find --show "$image")"
          mount -t ext4 "$loopdev" "$mountpoint"
        else
          loopdev="$(findmnt -n -o SOURCE --target "$mountpoint")"
        fi

        for root in workspace memory artifacts logs cache config; do
          if [ -L "/$root" ] || [ ! -e "/$root" ]; then
            ln -sfn "$mountpoint/$root" "/$root"
          fi
        done

        findmnt --target "$mountpoint"
        printf 'CONTEXTSDK_SYNTHETIC_MOUNT_JSON=%s\\n' "{{\\\"mountPath\\\":\\\"$mountpoint\\\",\\\"image\\\":\\\"$image\\\",\\\"source\\\":\\\"$loopdev\\\"}}"
        """
    )


def create_handoff_prompt(sandbox_id_value: str, question: RetrievalQuestion) -> str:
    return f"""# Blind Context Retrieval Task

You are connected to a fresh E2B Linux VM. Do not ask the user for extra context.

The VM has a mounted portable context filesystem at:

```txt
{MOUNT_PATH}
```

Convenience symlinks may also exist:

```txt
/workspace
/memory
/artifacts
/logs
/cache
/config
```

Your task:

```txt
{question.prompt}
```

Rules:
- Inspect the filesystem in the VM.
- Use only information found inside the mounted context.
- Return the answer and cite the file paths that support it.
- Do not assume the answer from this prompt.

E2B sandbox id:

```txt
{sandbox_id_value}
```
"""


def create_connect_instructions(sandbox_id_value: str) -> str:
    return f"""# Connect Another AI To This E2B VM

Give the other AI the sandbox id and the blind prompt in `handoff-prompt.md`.
Do not give it `answer-key.json`.

If the other AI can run Python with the E2B SDK:

```python
from e2b import Sandbox

sandbox = Sandbox.connect("{sandbox_id_value}")
result = sandbox.commands.run("find /mnt/contextsdk/synthetic-context -maxdepth 3 -type f | sort", user="root")
print(result.stdout)
```

The context is mounted at:

```txt
{MOUNT_PATH}
```

Useful inspection commands:

```bash
find /mnt/contextsdk/synthetic-context -maxdepth 4 -type f | sort
cat /memory/projects/meridian/decision-log.md
cat /workspace/customers/escalations.md
cat /.contextsdk/index.json
```
"""


def make_artifact_dir(repo_root: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_dir = repo_root / "artifacts" / f"synthetic-context-{stamp}"
    artifact_dir.mkdir(parents=True, exist_ok=False)
    return artifact_dir


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create and mount a synthetic context volume in E2B for blind AI retrieval tests.")
    parser.add_argument("--size-mb", type=int, default=64, help="Size of the ext4 context image.")
    parser.add_argument("--sandbox-timeout", type=int, default=3600, help="E2B sandbox lifetime in seconds.")
    parser.add_argument("--command-timeout", type=float, default=900, help="Remote command timeout in seconds.")
    parser.add_argument("--question-id", default="q1_launch_blocker", choices=[question.id for question in QUESTIONS])
    parser.add_argument("--keep-sandbox", action="store_true", default=True, help="Keep sandbox alive for the other AI.")
    parser.add_argument("--kill-sandbox", action="store_false", dest="keep_sandbox", help="Kill sandbox after setup.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    repo_root = Path(__file__).resolve().parents[1]
    artifact_dir = make_artifact_dir(repo_root)
    logger = RedactingLogger(artifact_dir / "setup.log")
    image_path = artifact_dir / "synthetic-context.ext4.img"
    staging = artifact_dir / "staging"
    answer_key_path = artifact_dir / "answer-key.json"
    handoff_prompt_path = artifact_dir / "handoff-prompt.md"
    connect_path = artifact_dir / "connect-other-ai.md"
    summary_path = artifact_dir / "summary.json"

    selected_question = next(question for question in QUESTIONS if question.id == args.question_id)
    sandbox = None
    setup_succeeded = False

    summary: dict[str, Any] = {
        "artifact_dir": str(artifact_dir),
        "answer_key": str(answer_key_path),
        "handoff_prompt": str(handoff_prompt_path),
        "connect_instructions": str(connect_path),
        "image_path": str(image_path),
        "mount_path": MOUNT_PATH,
        "remote_image": REMOTE_IMAGE,
        "question_id": selected_question.id,
        "passed": False,
        "sandbox_id": None,
    }

    try:
        if not os.environ.get("E2B_API_KEY"):
            raise TrialError("E2B_API_KEY is not set in the environment.")

        answer_key = prepare_synthetic_tree(staging)
        write_json(answer_key_path, answer_key, mode=0o600)
        create_ext4_image(logger, image_path, staging, args.size_mb)

        Sandbox = load_e2b_sandbox_class()
        sandbox = Sandbox.create(
            timeout=args.sandbox_timeout,
            secure=True,
            metadata={"purpose": "contextsdk-synthetic-retrieval-trial"},
        )
        summary["sandbox_id"] = sandbox_id(sandbox)

        uploaded_bytes = upload_raw(sandbox, logger, image_path, REMOTE_IMAGE)
        summary["uploaded_bytes"] = uploaded_bytes

        remote_script = "/tmp/contextsdk-mount-synthetic.sh"
        write_remote_script(sandbox, remote_script, mount_script())
        mount_output = run_remote(sandbox, logger, "mount synthetic context", f"chmod 700 {remote_script} && {remote_script}", timeout=args.command_timeout)
        summary["mount_output"] = logger.redact(mount_output)

        probe = run_remote(
            sandbox,
            logger,
            "probe mounted context",
            f"find {MOUNT_PATH} -maxdepth 4 -type f | sort && cat {MOUNT_PATH}/memory/projects/meridian/decision-log.md",
            timeout=120,
        )
        summary["probe_output"] = logger.redact(probe)

        write_text(handoff_prompt_path, create_handoff_prompt(summary["sandbox_id"], selected_question), mode=0o600)
        write_text(connect_path, create_connect_instructions(summary["sandbox_id"]), mode=0o600)
        summary["passed"] = True
        setup_succeeded = True
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(summary_path, summary)
        print(f"Synthetic context trial ready: {artifact_dir}")
        print(f"Sandbox id: {summary['sandbox_id']}")
        print(f"Handoff prompt: {handoff_prompt_path}")
        print(f"Answer key: {answer_key_path}")
        return 0
    except Exception as exc:
        summary["error"] = logger.redact(f"{type(exc).__name__}: {exc}")
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(summary_path, summary)
        print(f"Synthetic context trial failed. Summary: {summary_path}")
        return 1
    finally:
        if sandbox is not None and (not args.keep_sandbox or not setup_succeeded):
            try:
                sandbox.kill()
            except Exception as exc:
                logger.write(f"Failed to kill sandbox: {logger.redact(exc)}\n")


if __name__ == "__main__":
    raise SystemExit(main())
