# @contextsdk/core

Core SDK for contextSDK.

It handles encrypted context bundles, storage, locks, manifests, checkpoints, version metadata, file APIs, and the runtime adapter contract.

ESM-only, Node.js >= 20 (`import`; no `require`). The control plane shells out to `tar`, `zstd`, and `python3`, so it runs on POSIX hosts (macOS, Linux, WSL).

```bash
npm install @contextsdk/core
```

```ts
import { FsStorage, S3Storage, runWithContext } from "@contextsdk/core";
```

Install a runtime adapter separately:

```bash
npm install @contextsdk/adapter-vercel
npm install @contextsdk/adapter-e2b
npm install @contextsdk/adapter-modal
```

## Storage

`FsStorage` is a durable local-filesystem store for single-machine use (development, personal agents, CI). It implements the same `StorageAdapter` interface and conditional-write semantics as `S3Storage`: ETags are content hashes and per-key writes are serialized by an atomic lock directory, so the compare-and-swap lock protocol holds between processes on one machine. Use `S3Storage` for anything multi-machine.

```ts
import { FsStorage, defaultFsStorageDirectory } from "@contextsdk/core";

const storage = new FsStorage({ directory: defaultFsStorageDirectory(process.env.HOME!) });
// defaultFsStorageDirectory(home) resolves to <home>/.contextsdk/storage
```

Bundles are written under fresh, generation-scoped keys (`contexts/<id>/tree/<generation>-<attempt>...`) and the manifest write is the single atomic commit point, validated with an ETag compare-and-swap. An interrupted save can never strand a manifest pointing at ciphertext it cannot decrypt; superseded objects are garbage-collected after commit. A concurrent writer or lock takeover aborts the save with `ContextLockError`.

## Runtime adapters

`RuntimeAdapter` is the contract an adapter implements. Beyond `run`/`uploadFile`/`downloadFile`, an adapter may implement `keepAlive()`, which the session heartbeat calls periodically to extend a sandbox whose timeout would otherwise auto-terminate it mid-session, and `kill()`, which tears the sandbox down unconditionally (crash simulation / forced teardown — unlike `dispose()`, which only destroys sandboxes the adapter created). Remote pack/unpack/mount/save commands run with a 15-minute timeout by default, overridable per call via the `commandTimeoutMs` option on `runWithContext`, attach, save, and detach.

## Crash detection and recovery

The session heartbeat reports lock-renewal and keepAlive failures; after `recovery.failureThreshold` consecutive failures (default 3) the session is declared degraded and fires one best-effort emergency checkpoint. With the opt-in `recovery: { enabled: true }` option on `runWithContext`, a sandbox that dies mid-run is destroyed, re-provisioned through the same provisioner, and re-attached from the latest committed manifest under the same lock owner; `reinvoke: true` re-runs the callback (off by default — re-execution is the caller's idempotency call), and `onRecover` receives the recovered session. Recovery is refused for caller-supplied runtimes. `onSessionEvent` surfaces `heartbeat-failure`, `degraded`, `emergency-checkpoint`, and `recovery-*` lifecycle events.

A non-zero remote command throws `RuntimeCommandError`, which carries `exitCode`, `stdout`, and `stderr` (all error classes extend `ContextSDKError`).

```ts
import { runWithContext, RuntimeCommandError } from "@contextsdk/core";

try {
  await runWithContext({
    id: "agent-123",
    storage,
    encryption: { passphrase: process.env.CONTEXTSDK_PASSPHRASE! },
    provisioner,
    createIfMissing: true,
    commandTimeoutMs: 20 * 60_000,
  }, async session => {
    await session.files.write("workspace/task.txt", "current task state\n");
  });
} catch (error) {
  if (error instanceof RuntimeCommandError) {
    console.error(error.exitCode, error.stderr);
  }
}
```

Full docs: https://github.com/robzilla1738/ContextSDK
