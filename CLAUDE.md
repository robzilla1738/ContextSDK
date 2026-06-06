# AGENTS.md

## Project

contextSDK is a TypeScript-first SDK and CLI for persistent agent context across disposable sandboxes and VMs.

The product model is two-layer state:

- Portable context: encrypted user and agent files that move across providers.
- Runtime state: provider-local machine state for installed packages, dependency caches, virtualenvs, build output, and snapshots.

Do not collapse these layers. The portable context is the cross-provider source of truth. Provider persistence and snapshots are accelerators.

## Repository Layout

- `src/`: `@contextsdk/core` source.
- `packages/core/`: npm package wrapper for core build output.
- `packages/cli/`: `contextsdk` CLI package.
- `packages/adapter-e2b/`: E2B adapter (e2b SDK v2).
- `packages/adapter-vercel/`: Vercel Sandbox adapter.
- `packages/adapter-modal/`: Modal adapter.
- `examples/`: runnable scenario docs.
- `docs/enterprise-rollout.md`: enterprise architecture and rollout guide.
- `scripts/validate_portable_fs.py`: legacy E2B/ext4 validation harness (run with `python3` after `pip install e2b httpx`).
- `.github/workflows/ci.yml`: CI (typecheck, tests, CLI smoke, pack dry-run on Node 20/22/24).

## Core Invariants

- Never write secrets into repo files, logs, fixtures, docs, or artifacts.
- Never use text APIs for raw image or bundle transfer.
- Keep decrypted local temp files private and delete them after use, including when decryption fails mid-stream.
- Enforce one active writer per context with storage-backed locks. Lock acquisition uses conditional writes (`ifNoneMatch` on create, ETag `ifMatch` on expired-lock takeover), sessions renew the lock at TTL/3, and saves assert lock ownership when an owner is known.
- **Commit protocol**: bundle and image objects are written under generation-scoped, per-attempt keys (`contexts/<id>/tree/<gen>-<attempt>...`); the manifest write is the atomic commit and uses ETag compare-and-swap, with lock ownership re-asserted at the commit point. Never write current data in place at a fixed key — a crash between data and manifest writes must never strand a manifest pointing at ciphertext it cannot decrypt. Superseded data objects are garbage-collected after commit; checkpoint history is not.
- Decryption follows the parameters recorded in `EncryptionMetadata` (including scrypt params); never change defaults in a way that breaks decryption of existing bundles. Auth tags must be exactly 16 bytes and nonces 12 bytes — metadata is attacker-influenceable and must not be able to weaken verification.
- Reject archive entries that traverse paths (any `..` segment, including trailing), contain absolute or `..` link targets, or are special files (devices, FIFOs, sockets). Enforce this on **both** the host side (`assertSafeArchive`) and the runtime side (the python stream-validator in `unpackBundleScript`), with entry-count and decompressed-size caps.
- Context ids are validated (`assertValidContextId`): letters/digits plus `._-`, max 200 chars. Storage keys embed the raw id.
- Manifest version records are bounded summaries (`files: []`, capped history); full per-file indexes live inside the bundle at `.contextsdk/versions/`.
- Portable bundles must default to user/agent state only.
- Keep dependency-heavy paths out of the portable bundle by default:
  - `**/node_modules/**`
  - `**/.pnpm-store/**`
  - `**/.npm/**`
  - `**/.yarn/cache/**`
  - `**/.next/**`
  - `**/dist/**`
  - `**/build/**`
  - `**/.venv/**`
  - `**/__pycache__/**`
- `/cache` can exist in runtimes, but it is not part of the default portable bundle.
- Preserve provider runtime state on attach. Do not wipe a provider mount root if doing so would delete excluded runtime-state files.

## Runtime Behavior

Mount-mode decision (shared by attach/save/detach — session callers pass the actual mounted mode so the layers can never disagree): tree contexts use the unprivileged directory-bundle path whenever the runtime supports it; the loop-ext4 path is only for contexts whose current data is an ext4 image.

Sandbox lifetimes: provider defaults (~5 minutes) kill agent sessions, so adapters default to E2B 30 min, Vercel 45 min, Modal 60 min. E2B and Vercel implement `keepAlive()`, called by the session heartbeat (same cadence as lock renewal) to extend the countdown while a session runs. Remote pack/unpack/mount/save commands get a 15-minute default timeout (`commandTimeoutMs`).

Crash detection and recovery: the heartbeat reports renew/keepAlive outcomes; after `recovery.failureThreshold` consecutive failures (default 3) the session is degraded and fires one best-effort emergency checkpoint. `recovery` on `runWithContext` is opt-in and **refused for caller-supplied runtimes** — the SDK only re-provisions sandboxes it created. Recovery destroys the dead sandbox, provisions a fresh one, and re-attaches with the **same lock owner** (`acquireLock` adopts an unexpired same-owner lock instead of refusing; a failed re-attach must not release an adopted lock). `reinvoke` defaults to false (callback idempotency is the caller's call); the CLI `run --recover` opts in. Adapters expose optional `kill()` — unconditional teardown for crash simulation, unlike ownership-checked `dispose()`. `contextsdk test crash-recovery --execute` crashes a real sandbox and asserts checkpointed state survives while uncheckpointed state is lost.

E2B:

- Tree contexts (default) use the directory-bundle path — no host ext4 tooling.
- Explicit ext4 contexts build the image on the host (needs `e2fsprogs`) and loop-mount in the sandbox.
- Presigned-URL transfers retry with backoff; fresh sandboxes can take >10s before ingress resolves.

Vercel:

- Uses directory bundles.
- Defaults to persistent named sandboxes, derived from the context id: `contextsdk-<contextId>`.
- Keeps `node_modules`, package caches, and build output in Vercel runtime state, not the portable bundle.
- Records runtime-state metadata in `manifest.json` when available.
- Headless auth needs the full `token`/`teamId`/`projectId` triple (CLI reads `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`) or `VERCEL_OIDC_TOKEN`.
- Stopped persistent sandboxes expire their snapshots (default 14 days); an expired sandbox is recreated empty and only the portable context is restored.

Modal:

- Uses Modal Sandbox with Volume-backed directories.
- Still exports the encrypted tree bundle so context can move to another provider.
- No extend-at-runtime API in the JS SDK; size `timeoutMs` to the workload (max 24h). `dispose()` only terminates sandboxes the adapter created.

SSH:

- Attach-only runtime (no provisioner). Uses the directory-bundle path, wraps remote commands in `bash -lc` (core scripts use `pipefail`, which dash rejects), and passes `BatchMode=yes` + `ConnectTimeout` so it never hangs on prompts.

## Storage and CLI

- CLI storage resolution: explicit S3 (env or config) → `CONTEXTSDK_STORAGE_DIR`/config fs directory → `~/.contextsdk/storage` (local `FsStorage`, content-hash ETags, per-key lock dirs for CAS). The CLI must keep working with zero cloud configuration.
- `contextsdk run` prints the wrapped command's stdout/stderr and propagates its exit code; `--json` emits the envelope.
- Host prerequisites: Node >= 20, POSIX (`tar`, `zstd`, `python3`); packages are ESM-only. Windows is unsupported outside WSL.

## Package Status

Published on npm (install verified on 2026-06-05 via `npm install` in a clean directory):

- `@contextsdk/core@0.4.0`
- `@contextsdk/adapter-e2b@0.4.0`
- `@contextsdk/adapter-vercel@0.4.0`
- `@contextsdk/adapter-modal@0.4.0`
- `@contextsdk/cli@0.4.0`

0.4.0 (tagged `v0.4.0`) is the current release. See `CHANGELOG.md` for the full list: heartbeat failure detection with degraded-state emergency checkpoints, opt-in session recovery on `runWithContext` (re-provision + same-owner lock adoption + optional reinvoke), adapter `kill()`, CLI `run --recover`, a real `test crash-recovery` scenario, and one API breaking change (`acquireLock` returns `{ lock, adopted }`).

Compatibility: 0.4.0 uses the same storage layout and commit protocol as 0.3.0 (contexts are interchangeable between the two). 0.3.0/0.4.0 read contexts written by 0.1.0/0.2.0 (legacy fixed `current.*` keys migrate on next save), and 0.2.0 can read contexts saved by 0.3.0/0.4.0. Bundles encrypted with the 0.2.0+ default scrypt parameters cannot be decrypted by 0.1.0.

## Commands

Run these before claiming implementation work is complete:

```bash
npm run typecheck
npm test
npm run build
node packages/cli/dist/cli.js doctor
node packages/cli/dist/cli.js run --help
node packages/cli/dist/cli.js probe --help
git diff --check
```

Use `npm pack --dry-run --json -w <workspace>` before publishing a package.

## Publishing

Publish packages in dependency order:

```bash
npm publish -w @contextsdk/core --access public
npm publish -w @contextsdk/adapter-e2b --access public
npm publish -w @contextsdk/adapter-vercel --access public
npm publish -w @contextsdk/adapter-modal --access public
npm publish -w @contextsdk/cli --access public
```

If npm asks for MFA, do not put tokens or recovery codes in shell command history. Read them through stdin or use a temporary npm token. Remove any token from `~/.npmrc` after publishing. Update `CHANGELOG.md` (date the release) and the Package Status sections here and in `README.md` after install verification.

## Documentation Rules

- Keep `README.md`, package READMEs, examples, and `docs/enterprise-rollout.md` consistent.
- Keep published package status aligned with install verification and release notes.
- When changing runtime persistence behavior, update the two-layer state explanation.
- When changing default persisted roots or exclude patterns, update docs and tests together.
- When changing storage key layout or the commit protocol, update the Storage layout section in `README.md` and the compatibility notes here.

## GitHub

The public repo is:

```text
https://github.com/robzilla1738/ContextSDK
```

Keep GitHub metadata aligned with the project:

- Description: `Portable encrypted context state for AI sandboxes and VMs`
- Homepage: `https://www.npmjs.com/org/contextsdk`
- Topics should include: `ai-agents`, `sandbox`, `filesystem`, `persistence`, `typescript`, `e2b`, `vercel`, `modal`

For release tags, use semver tags such as `v0.3.0`.

## Implementation Style

- Prefer existing project patterns over new abstractions.
- Keep changes scoped and practical.
- Add tests for behavior changes, especially persistence policy, versioning, locks, runtime adapters, and CLI command construction.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Do not revert unrelated changes.
