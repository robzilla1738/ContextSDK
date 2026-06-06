# contextSDK

[![CI](https://github.com/robzilla1738/ContextSDK/actions/workflows/ci.yml/badge.svg)](https://github.com/robzilla1738/ContextSDK/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40contextsdk%2Fcore)](https://www.npmjs.com/org/contextsdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

contextSDK gives agents a real filesystem that survives disposable sandboxes and VMs.

Agent runtimes should usually be temporary. That is safer, but it makes continuity hard. contextSDK keeps the compute disposable and stores the agent's working state separately as an encrypted portable bundle that moves across E2B, Vercel Sandbox, Modal, and SSH hosts.

Inside the runtime, the agent gets the same folders every time: `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`.

## Quick start

No cloud bucket required — without S3 configuration, contexts live encrypted in a local store (`~/.contextsdk/storage`):

```bash
npm install -g @contextsdk/cli @contextsdk/core @contextsdk/adapter-e2b @contextsdk/adapter-vercel @contextsdk/adapter-modal
export CONTEXTSDK_PASSPHRASE="choose-a-strong-passphrase"
contextsdk doctor

# Run a command in an E2B sandbox with a persistent context:
export E2B_API_KEY="..."
contextsdk run my-agent --runtime e2b --create-if-missing -- sh -lc 'echo hello > /workspace/state.txt'

# A different sandbox — even a different provider — sees the same state:
contextsdk run my-agent --runtime e2b -- cat /workspace/state.txt
```

### Prerequisites

- Node.js >= 20. The packages are ESM-only (`import`; no `require`).
- A POSIX host: macOS, Linux, or WSL. The control plane shells out to `tar`, `zstd`, and `python3`.
- `e2fsprogs` (`mkfs.ext4`, `e2fsck`) **only** if you use the optional `--format ext4` contexts. The default tree format never needs it. macOS: `brew install e2fsprogs`.

### Provider credentials

| Provider | Credentials |
| --- | --- |
| E2B | `E2B_API_KEY` ([dashboard](https://e2b.dev/dashboard)) |
| Vercel | `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`, **or** `VERCEL_OIDC_TOKEN` (from `vercel link` + `vercel env pull`, expires ~12h) |
| Modal | `~/.modal.toml` (from `modal token new`) or `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` |
| SSH | Plain `ssh`/`scp` with key auth; the remote host needs `bash`, `tar`, `zstd`, `python3`, and passwordless `sudo` for root operations |

`contextsdk doctor` reports which credentials and tools it can see without printing secret values.

## Two-layer state

contextSDK splits state into two layers:

- **Portable context**: encrypted user and agent state that moves across providers. Defaults to `/workspace`, `/memory`, `/artifacts`, `/logs`, and `/config`.
- **Runtime state**: provider-specific machine state — installed packages, `node_modules`, virtualenvs, language caches, build output, and `/cache`. These are expensive to push through object storage and are better served by provider persistence (Vercel named sandboxes, Modal volumes).

The portable bundle excludes `node_modules`, package stores, virtualenvs, `.next`, `dist`, and `build` output by default, and re-attach never wipes provider runtime state outside the managed roots.

## Storage layout

```text
contexts/<contextId>/manifest.json                          # commit point; references current data
contexts/<contextId>/lock.json                              # single-writer lock (conditional writes)
contexts/<contextId>/tree/<generation>-<attempt>.tree.tar.zst.enc
contexts/<contextId>/image/<generation>-<attempt>.img.enc   # explicit ext4 contexts only
contexts/<contextId>/checkpoints/<n>.tree.tar.zst.enc
```

Bundles are written under fresh generation-scoped keys and the manifest write is the atomic commit, so an interrupted save can never corrupt the previous generation. Contexts created by older releases (fixed `current.*` keys) are read transparently and migrate on their next save.

## Packages

- `@contextsdk/core`: storage, encryption, locks, manifests, checkpoints, file APIs, SSH adapter.
- `@contextsdk/cli`: the `contextsdk` command.
- `@contextsdk/adapter-e2b`: E2B sandboxes (e2b SDK v2).
- `@contextsdk/adapter-vercel`: Vercel Sandbox with persistent named sandboxes.
- `@contextsdk/adapter-modal`: Modal Sandbox and Volume support.

Adapters declare `@contextsdk/core` as a peer dependency; npm 7+ installs it automatically.

Published on npm: `0.3.0` (install verified 2026-06-05). See [CHANGELOG.md](CHANGELOG.md) for what changed since 0.2.0, including one CLI breaking change (`contextsdk run` output).

## Configure

Storage resolution order: explicit S3 (env or config) → explicit local directory → `~/.contextsdk/storage`.

```bash
# Local store (default): nothing to configure, or pick a directory:
export CONTEXTSDK_STORAGE_DIR="/srv/contexts"

# S3-compatible storage (AWS S3, Cloudflare R2, MinIO) for multi-machine use:
export CONTEXTSDK_S3_BUCKET="agent-contexts"
export CONTEXTSDK_S3_REGION="auto"
export CONTEXTSDK_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"
export CONTEXTSDK_S3_ACCESS_KEY_ID="..."
export CONTEXTSDK_S3_SECRET_ACCESS_KEY="..."

# Encryption (always required):
export CONTEXTSDK_PASSPHRASE="..."     # or CONTEXTSDK_KEY_HEX (raw 32-byte key, hex)
```

For repeatable runs, copy the example config:

```bash
cp contextsdk.config.example.ts contextsdk.config.ts
```

Provider credentials stay in the environment, never in config files or argv.

## CLI examples

```bash
contextsdk doctor                                  # check setup
contextsdk init employee-robert                    # create a context
contextsdk status employee-robert                  # manifest + lock state
contextsdk verify employee-robert                  # stored objects exist and are encrypted
```

Run in E2B with periodic checkpoints:

```bash
contextsdk run employee-robert --runtime e2b --create-if-missing --checkpoint-interval 5m -- sh -lc 'echo ok > /workspace/result.txt'
```

`run` prints the wrapped command's stdout/stderr and exits with its exit code. Pass `--json` for a machine-readable envelope.

Move the same context to Vercel Sandbox:

```bash
contextsdk run employee-robert --runtime vercel -- sh -lc 'cat /workspace/result.txt'
```

Use Vercel runtime state for dependency-heavy Node work (note the Node runtime image):

```bash
contextsdk run employee-robert --runtime vercel --vercel-runtime node24 -- sh -lc 'cd /workspace && npm init -y && npm install is-odd'
contextsdk run employee-robert --runtime vercel --vercel-runtime node24 -- sh -lc 'test -d /workspace/node_modules && echo deps survived'
```

The second run resumes the same named sandbox (`contextsdk-employee-robert`). `node_modules` stays in Vercel provider state and out of the portable bundle. To force an ephemeral sandbox, pass `--runtime-state disabled --no-vercel-persistent`. Note: stopped persistent sandboxes keep snapshots for 14 days by default (`--vercel-snapshot-expiration`); after expiry the sandbox comes back empty and only the portable context is restored.

Run it in Modal:

```bash
contextsdk run employee-robert --runtime modal -- sh -lc 'echo modal > /workspace/provider.txt'
```

Probe a runtime, or drive the lifecycle manually:

```bash
contextsdk probe --runtime e2b
contextsdk session start employee-robert --runtime e2b
contextsdk files write employee-robert workspace/notes.txt "hello" --runtime e2b --sandbox-id <id>
contextsdk session save employee-robert --runtime e2b --sandbox-id <id> --owner <owner-from-start>
contextsdk session end employee-robert --runtime e2b --sandbox-id <id> --owner <owner-from-start>
```

The sandbox id for `--sandbox-id` is the suffix of `runtimeId` in `session start` output (`e2b:<sandbox-id>`).

## SDK example

```ts
import { FsStorage, runWithContext } from "@contextsdk/core";
import { E2BProvisioner } from "@contextsdk/adapter-e2b";

// FsStorage for local/single-machine use; swap in S3Storage for production.
const storage = new FsStorage({ directory: `${process.env.HOME}/.contextsdk/storage` });

await runWithContext({
  id: "agent-123",
  storage,
  encryption: { passphrase: process.env.CONTEXTSDK_PASSPHRASE! },
  provisioner: new E2BProvisioner({ apiKey: process.env.E2B_API_KEY }),
  createIfMissing: true,
  checkpoint: { intervalMs: 300_000 },
  recovery: { enabled: true, reinvoke: true },
  message: "agent session",
}, async session => {
  await session.files.write("workspace/task.txt", "current task state\n");
  await session.memory.append("User prefers concise answers.");
  await session.artifacts.write("result.txt", "final artifact\n");
  await session.logs.append("task completed");
});
```

`runWithContext` checkpoints on the configured interval, renews the single-writer lock, keeps the sandbox alive while the session runs, and saves and cleans up on `SIGINT`/`SIGTERM`. A hard kill can still lose work after the last checkpoint.

### Crash detection and recovery

The session heartbeat reports lock-renewal and keepAlive failures; after `recovery.failureThreshold` consecutive failures (default 3) the session is declared degraded and fires one best-effort emergency checkpoint while the sandbox may still be reachable. With `recovery.enabled`, a sandbox that dies mid-run is replaced: the SDK destroys it, provisions a fresh one through the same provisioner, re-attaches from the latest committed manifest (which includes the newest checkpoint), and — with `reinvoke: true` — re-runs the callback. The storage lock is held by the same owner across sandboxes, so no other writer can slip in during recovery.

- Recovery is opt-in and refused for caller-supplied runtimes: the SDK only re-provisions sandboxes it created.
- `reinvoke` defaults to `false` because the SDK cannot know an arbitrary callback is idempotent; without it, supply `recovery.onRecover` to use the recovered session before the original error is rethrown.
- `onSessionEvent` receives `heartbeat-failure`, `degraded`, `emergency-checkpoint`, and `recovery-*` lifecycle events.
- The CLI equivalent is `contextsdk run --recover`, which re-runs the wrapped command on the recovered sandbox.
- Adapters expose an optional `kill()` (unconditional teardown, unlike ownership-checked `dispose()`); `contextsdk test crash-recovery <id> --runtime e2b --execute` uses it to crash a real sandbox and assert that checkpointed state survives and uncheckpointed state is lost.

## How each runtime works

All providers attach tree contexts (the default) through the unprivileged **directory-bundle** path: the encrypted bundle is decrypted locally, validated, uploaded, then stream-validated and extracted inside the runtime. Saves pack the managed roots in the runtime, download, encrypt locally, and commit to storage under a fresh generation key.

Sandbox lifetimes: providers kill sandboxes after ~5 minutes by default. The adapters default to session-sized lifetimes instead (E2B 30 min, Vercel 45 min, Modal 60 min — all configurable), and the E2B/Vercel adapters extend the countdown while a session is actively running.

E2B:

- Default tree contexts use the directory bundle; no ext4 tooling needed anywhere.
- Explicit `--format ext4` contexts build the image on the host (requires `e2fsprogs`), upload it, and loop-mount it in the sandbox.
- Transfers ride presigned URLs with retry/backoff against fresh-sandbox ingress flakiness.

Vercel Sandbox:

- Unpacks the bundle into `/vercel/sandbox/contextsdk/<id>`.
- Uses persistent named sandboxes (`contextsdk-<id>`) by default so installed packages and build output survive between sessions without entering the portable bundle.
- Records runtime-state metadata (sandbox name, snapshot ids) in the manifest.

Modal:

- Modal Sandbox with a Volume mounted at `/contextsdk`, one subdirectory per context.
- The volume accelerates re-attach; the encrypted tree bundle remains the portable source of truth.

SSH:

- Attach-only runtime for hosts you already manage; uses the directory-bundle path, `BatchMode` (never hangs on prompts), and `bash` for script execution.

## Security model

- Bundles and images are encrypted with AES-256-GCM. Decryption authenticates the ciphertext; tampered data fails closed, partially written plaintext is removed, and metadata cannot downgrade the auth-tag or nonce length.
- Passphrase keys derive via scrypt with parameters recorded in metadata (default `cost=131072, blockSize=8, parallelization=1`); legacy bundles decrypt with the recorded or legacy parameters. Raw 32-byte keys (`rawKeyHex`) skip derivation.
- One active writer per context: storage-backed locks with conditional writes (`If-None-Match` create, ETag `If-Match` takeover), TTL/3 renewal, ownership re-assertion and manifest compare-and-swap at every commit point.
- Archive safety is enforced on **both** sides of every transfer: path traversal, absolute paths, escaping symlink/hardlink targets, and special files are rejected, with entry-count and decompressed-size caps against decompression bombs.
- Decrypted data exists in two places during a session: a private local temp directory (mode 0600/0700, removed even on failure) and the runtime itself, which must see plaintext to do work. Treat runtime compromise as context compromise for that session.
- Secrets are read from the environment, never from argv. Use `contextsdk files write --stdin` to keep sensitive file content out of shell history.

See [SECURITY.md](SECURITY.md) for the reporting policy.

## Enterprise shape

The enterprise version puts a Context Broker in front of the SDK. The broker decides who can attach which context, enforces one active writer, records audit events, runs DLP or artifact scanning before save, and handles retention or legal hold. See [docs/enterprise-rollout.md](docs/enterprise-rollout.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
node packages/cli/dist/cli.js doctor
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The original Python validation harness lives in `scripts/` (`pip install e2b httpx`, then `python3 scripts/validate_portable_fs.py`).
