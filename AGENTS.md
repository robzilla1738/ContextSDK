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
- `packages/adapter-e2b/`: E2B adapter.
- `packages/adapter-vercel/`: Vercel Sandbox adapter.
- `packages/adapter-modal/`: Modal adapter.
- `examples/`: runnable scenario docs.
- `docs/enterprise-rollout.md`: enterprise architecture and rollout guide.
- `scripts/validate_portable_fs.py`: original E2B/ext4 validation harness.

## Core Invariants

- Never write secrets into repo files, logs, fixtures, docs, or artifacts.
- Never use text APIs for raw image or bundle transfer.
- Keep decrypted local temp files private and delete them after use.
- Enforce one active writer per context with storage-backed locks. Lock acquisition uses conditional writes (`ifNoneMatch` on create, ETag `ifMatch` on expired-lock takeover), sessions renew the lock at TTL/3, and saves assert lock ownership when an owner is known.
- Decryption follows the parameters recorded in `EncryptionMetadata` (including scrypt params); never change defaults in a way that breaks decryption of existing bundles.
- Reject archive entries that traverse paths, contain absolute or `..` link targets, or are special files (devices, FIFOs, sockets).
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

E2B:

- Uses loop-mounted ext4 where supported.
- Can materialize a tree bundle into an ext4 image for the runtime.
- For tree contexts, final save stores the filtered encrypted tree bundle. Explicit ext4 contexts may also update `current.img.enc`.

Vercel:

- Uses directory bundles.
- Defaults to persistent named sandboxes, derived from the context id: `contextsdk-<contextId>`.
- Keeps `node_modules`, package caches, and build output in Vercel runtime state, not the portable bundle.
- Records runtime-state metadata in `manifest.json` when available.

Modal:

- Uses Modal Sandbox with Volume-backed directories.
- Still exports the encrypted tree bundle so context can move to another provider.

SSH:

- Treat as an attach-only runtime unless a provisioner is added.

## Package Status

Published on npm (install verified on 2026-06-04 via `npm install` in a clean directory):

- `@contextsdk/core@0.1.0`
- `@contextsdk/adapter-e2b@0.1.0`
- `@contextsdk/adapter-vercel@0.1.0`
- `@contextsdk/adapter-modal@0.1.0`
- `@contextsdk/cli@0.1.0`

The repository is at `0.2.0` (unpublished). 0.2.0 adds: conditional-write (ETag CAS) lock acquisition and renewal, lock-ownership assertion on save, scrypt parameters recorded in encryption metadata with a stronger default (cost 2^17), symlink/hardlink/special-file validation in bundles, bounded manifest version history, and CLI fixes (dynamic version, exit-code propagation, `files write --stdin`).

Compatibility note: bundles encrypted by 0.2.0 with the new default scrypt parameters cannot be decrypted by 0.1.0 (it ignores the recorded parameters). 0.2.0 reads 0.1.0 bundles fine.

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

If npm asks for MFA, do not put tokens or recovery codes in shell command history. Read them through stdin or use a temporary npm token. Remove any token from `~/.npmrc` after publishing.

## Documentation Rules

- Keep `README.md`, package READMEs, examples, and `docs/enterprise-rollout.md` consistent.
- Keep published package status aligned with install verification and release notes.
- When changing runtime persistence behavior, update the two-layer state explanation.
- When changing default persisted roots or exclude patterns, update docs and tests together.

## GitHub

The public repo is:

```text
https://github.com/robzilla1738/ContextSDK
```

Keep GitHub metadata aligned with the project:

- Description: `Portable encrypted context state for AI sandboxes and VMs`
- Homepage: `https://www.npmjs.com/org/contextsdk`
- Topics should include: `ai-agents`, `sandbox`, `filesystem`, `persistence`, `typescript`, `e2b`, `vercel`, `modal`

For release tags, use semver tags such as `v0.1.0`.

## Implementation Style

- Prefer existing project patterns over new abstractions.
- Keep changes scoped and practical.
- Add tests for behavior changes, especially persistence policy, versioning, locks, runtime adapters, and CLI command construction.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Do not revert unrelated changes.
