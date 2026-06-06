# Changelog

All notable changes to the contextSDK packages are documented here. The project
follows [semver](https://semver.org); while major version is 0, minor releases
may contain breaking changes, called out explicitly below.

## Unreleased

### Crash detection and recovery

- The session heartbeat now reports lock-renewal and keepAlive outcomes;
  after `recovery.failureThreshold` consecutive failures (default 3) the
  session is declared degraded and fires one best-effort emergency checkpoint
  while the sandbox may still be reachable.
- New opt-in `recovery` option group on `runWithContext`: when the sandbox
  dies mid-run, the SDK destroys it, re-provisions through the same
  provisioner, re-attaches from the latest committed manifest, and (with
  `reinvoke: true`) re-runs the callback. Recovery is refused for
  caller-supplied runtimes. New `onSessionEvent` callback surfaces
  `heartbeat-failure`, `degraded`, `emergency-checkpoint`, and `recovery-*`
  lifecycle events.
- `acquireLock` adopts an unexpired lock held by the same owner (refreshing it
  via CAS) instead of refusing, so a recovering session re-attaches without
  waiting out its own lock TTL; a failed re-attach no longer force-releases an
  adopted lock. `acquireLock` now returns `{ lock, adopted }` instead of the
  bare lock.
- Adapters expose an optional `kill()` — unconditional sandbox teardown for
  crash simulation, unlike ownership-checked `dispose()`.
- `contextsdk run` gains `--recover`; `contextsdk test crash-recovery
  --execute` now actually crashes a sandbox mid-session and asserts that
  checkpointed state survives and uncheckpointed state is lost
  (`--auto-recovery` also exercises the re-provision + reinvoke path).

## 0.3.0 — 2026-06-05

### Data integrity

- **Save commit protocol**: encrypted bundles and ext4 images are now written
  under generation-scoped, per-attempt storage keys
  (`contexts/<id>/tree/<generation>-<attempt>...`), and the manifest write is
  the single atomic commit point. A crash or network failure mid-save can no
  longer strand a manifest pointing at ciphertext it cannot decrypt. Superseded
  objects are garbage-collected after commit. Contexts created by 0.2.0 and
  earlier (fixed `current.*` keys) are read transparently and migrate to the
  new layout on their next save.
- All manifest writes (save, checkpoint, runtime-state updates) use
  compare-and-swap on the storage ETag; a concurrent writer or lock takeover
  aborts the save loudly with `ContextLockError` instead of silently clobbering
  the other writer's data. Lock ownership is re-asserted at the commit point.
- Checkpoints now flip the manifest's `treeKey` to the checkpoint object
  instead of rewriting the current bundle in place.
- `createContext` uses a conditional manifest write, so two racing creators
  resolve to exactly one context.

### Encryption

- Decryption rejects auth tags that are not exactly 16 bytes and nonces that
  are not exactly 12 bytes; previously a rewritten manifest could downgrade the
  effective GCM tag strength.
- A failed (tampered) decryption removes the partially written plaintext file
  before rethrowing.
- Derived and raw key buffers are zeroed immediately after cipher construction.

### Providers

- **e2b SDK v2** (`e2b@^2.27`): the adapter migrated from the deprecated 1.x
  line.
- **Sandbox lifetimes**: all adapters now default to workload-appropriate
  sandbox timeouts (E2B 30 min, Vercel 45 min, Modal 60 min) instead of the
  providers' 5-minute defaults that killed sessions mid-run. E2B and Vercel
  adapters implement `keepAlive()`, which the session heartbeat calls to extend
  the sandbox while a session is actively running.
- **E2B transfer retries**: presigned-URL uploads/downloads retry with backoff
  on connect timeouts and 5xx responses; fresh-sandbox ingress flakiness no
  longer fails attach.
- **Tree contexts no longer require host ext4 tooling**: attach prefers the
  unprivileged directory-bundle path whenever the runtime supports it
  (including E2B). `mkfs.ext4`/`e2fsck` are only needed for explicit
  `--format ext4` contexts. The mounted mode is threaded through save and
  detach so they can never re-derive a conflicting path.
- E2B wrapped commands run with the per-command timeout disabled, so
  long-running work (`npm install`, builds) is no longer SIGKILLed at the
  e2b SDK's 60-second command default; the sandbox lifetime bounds the session.
- E2B and Modal adapters only terminate sandboxes they created, never
  caller-supplied or reattached ones (E2B gains the guard Modal already had).
- The Vercel keepAlive extends the deadline by the elapsed delta each beat
  rather than by the full timeout, so it tracks `now + timeout` without racing
  the plan's maximum execution timeout.
- The session heartbeat cadence is clamped below the sandbox lifetime, so a
  large `lockTtlMs` cannot let the first keepAlive fire after the sandbox dies.
- ext4 images materialized from tree bundles are sized from the decompressed
  tree, not the compressed bundle size.
- Remote pack/unpack/mount/save commands run with a 15-minute timeout
  (configurable via `commandTimeoutMs`) instead of inheriting provider SDK
  defaults as low as 60 seconds.
- Vercel adapter accepts `token`/`teamId`/`projectId` for headless
  authentication (also read from `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/
  `VERCEL_PROJECT_ID` by the CLI), and rejects unsupported `user` values
  instead of silently dropping them.
- Modal adapter no longer terminates sandboxes it did not create (passed via
  `sandbox`/`sandboxId`), and exposes `idleTimeoutMs`.
- SSH adapter attaches via the unprivileged directory-bundle path, wraps remote
  commands in `bash -lc` (core scripts use `pipefail`, which dash rejects), and
  passes `BatchMode=yes` + `ConnectTimeout` so it can never hang on interactive
  prompts.

### Security

- The runtime-side bundle unpack now stream-validates every archive member as
  root before extraction: path traversal, absolute paths, unsafe link targets,
  and special files are rejected, with entry-count and decompressed-size caps
  against decompression bombs. Previously only the host-side path validated.
- Host-side archive validation also catches trailing `..` components and caps
  entry counts and recorded decompressed sizes.
- Context ids are validated (letters, digits, `._-`, max 200 chars) so storage
  keys and remote paths cannot embed traversal.
- Local packing no longer falls back to archiving the entire directory when no
  managed roots exist.

### CLI and onboarding

- **Works without S3**: when no bucket is configured the CLI stores contexts in
  a local directory store (`~/.contextsdk/storage`, override with
  `CONTEXTSDK_STORAGE_DIR` or `storage.type: "fs"`). `FsStorage` implements the
  same conditional-write semantics as S3 (write-identity ETags so CAS is
  ABA-safe, heartbeat-protected per-key locks), so the lock protocol holds
  across processes on one machine. An explicit `storage.type: "fs"` is honored
  over a stray `CONTEXTSDK_S3_BUCKET` in the environment.
- `contextsdk run`'s wrapped command is taken verbatim from after `--`, so a
  flag that belongs to the command (e.g. `--json`) is never consumed by the CLI.
- Storage adapters gain an optional `listObjects(prefix)`; `force`-recreating a
  context now reclaims its historical generation and checkpoint objects instead
  of leaking them.
- **Breaking**: `contextsdk run` now prints the wrapped command's stdout/stderr
  directly and exits with its exit code; pass `--json` for the previous JSON
  envelope.
- `doctor` reports the resolved storage backend, python3, and ext4 tooling
  (marked as needed only for `--format ext4`), and recognizes `~/.modal.toml`.
- Every command has a `--help` description.

### Packaging

- Adapters declare `@contextsdk/core` as a peer dependency; two copies of core
  in one application would break `instanceof` checks on shared error classes.
- All packages set `sideEffects: false`.
- `assertSuccess` failures throw `RuntimeCommandError` (with `exitCode`,
  `stdout`, `stderr`) instead of a bare `Error`.
- `runWithContext` honors `saveOnError: false` on all failure paths.

## 0.2.0 — 2026-06-05

- Conditional-write (ETag CAS) lock acquisition and renewal; lock-ownership
  assertion on save.
- scrypt parameters recorded in encryption metadata with a stronger default
  (cost 2^17). Bundles encrypted by 0.2.0 cannot be decrypted by 0.1.0; 0.2.0
  reads 0.1.0 bundles.
- Symlink/hardlink/special-file validation in bundles.
- Bounded manifest version history.
- CLI fixes: dynamic version, exit-code propagation, `files write --stdin`.

## 0.1.0 — 2026-06-04

- Initial release: encrypted portable context bundles, E2B/Vercel/Modal/SSH
  runtimes, storage-backed locks, versioning, CLI.
