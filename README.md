# contextSDK

contextSDK gives agents a real filesystem that survives disposable sandboxes and VMs.

Agent runtimes should usually be temporary. That is safer, but it makes continuity hard. contextSDK keeps the compute disposable and stores the agent's working state separately as an encrypted portable bundle.

The default storage object is:

- `contexts/<contextId>/current.tree.tar.zst.enc`

Each context also has:

- `contexts/<contextId>/manifest.json`
- `contexts/<contextId>/lock.json`
- `contexts/<contextId>/checkpoints/<generation>.tree.tar.zst.enc`

E2B and SSH-style runtimes can also keep a raw ext4 image for loop mounting:

- `contexts/<contextId>/current.img.enc`

Inside the runtime, the agent gets the same folders every time: `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`.

## Two-layer state

contextSDK splits state into two layers:

- Portable context: encrypted user and agent state that can move across E2B, Vercel, Modal, and SSH.
- Runtime state: provider-specific machine state such as installed packages, `node_modules`, virtualenvs, language caches, and build output.

The portable bundle defaults to `/workspace`, `/memory`, `/artifacts`, `/logs`, and `/config`. It leaves out `/cache`, `node_modules`, package stores, virtualenvs, `.next`, `dist`, and `build` output. Those paths are expensive to push through object storage and are better handled by provider persistence or snapshots.

Vercel is the first runtime-state implementation. By default, contextSDK uses a persistent named Vercel Sandbox named `contextsdk-<contextId>`. The encrypted context still comes from cloud storage at session start and is saved back at the end. Dependencies stay warm in the sandbox. User and agent context stays portable.

## Packages

- `@contextsdk/core`: storage, encryption, locks, manifests, checkpoints, file APIs.
- `@contextsdk/cli`: the `contextsdk` command.
- `@contextsdk/adapter-e2b`: E2B loop-mounted ext4 support.
- `@contextsdk/adapter-vercel`: Vercel Sandbox directory-bundle support.
- `@contextsdk/adapter-modal`: Modal Sandbox and Volume support.

## Install

```bash
npm install
npm run build
```

Local CLI:

```bash
npx contextsdk --help
```

## Configure

For a quick trial, use environment variables:

```bash
export CONTEXTSDK_S3_BUCKET="agent-contexts"
export CONTEXTSDK_S3_REGION="auto"
export CONTEXTSDK_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"
export CONTEXTSDK_S3_ACCESS_KEY_ID="..."
export CONTEXTSDK_S3_SECRET_ACCESS_KEY="..."
export CONTEXTSDK_PASSPHRASE="..."
```

For repeatable runs, copy the example config:

```bash
cp contextsdk.config.example.ts contextsdk.config.ts
```

Example:

```ts
import type { ContextSDKConfig } from "@contextsdk/core";

export default {
  storage: {
    type: "s3",
    bucket: "agent-contexts",
    region: "auto",
    endpoint: "https://<account>.r2.cloudflarestorage.com",
    forcePathStyle: true,
  },
  encryption: {
    passphraseEnv: "CONTEXTSDK_PASSPHRASE",
  },
  defaultRuntime: "e2b",
  defaultFormat: "tree",
  runtimeState: "auto",
  persistence: {
    roots: ["workspace", "memory", "artifacts", "logs", "config"],
  },
  checkpoint: {
    intervalMs: 300000,
  },
  providers: {
    vercel: { runtime: "python3.13", persistent: true, snapshotExpirationMs: 1209600000, keepLastSnapshots: 3 },
    modal: { appName: "contextsdk", imageTag: "python:3.13-slim", volumeName: "contextsdk-contexts" },
  },
} satisfies ContextSDKConfig;
```

Provider credentials stay in the environment. The CLI reads `E2B_API_KEY`, Vercel auth, Modal auth, and S3 credentials, but `doctor` does not print secret values.

## CLI examples

Check local setup:

```bash
npx contextsdk doctor
```

Create a context:

```bash
npx contextsdk init employee-robert --format tree
```

Run in E2B, checkpoint every five minutes, save, detach, and shut the sandbox down:

```bash
export E2B_API_KEY="..."
npx contextsdk run employee-robert --runtime e2b --create-if-missing --checkpoint-interval 5m -- sh -lc 'echo ok > /workspace/result.txt'
```

Run the same context in Vercel Sandbox:

```bash
npx contextsdk run employee-robert --runtime vercel --create-if-missing -- sh -lc 'echo vercel >> /memory/session.md'
```

Use Vercel runtime state for dependency-heavy work:

```bash
npx contextsdk run employee-robert --runtime vercel --create-if-missing -- sh -lc 'npm install && echo ok > /workspace/result.txt'
npx contextsdk run employee-robert --runtime vercel -- sh -lc 'test -d node_modules && cat /workspace/result.txt'
```

The second run resumes the same named sandbox by default. `node_modules` stays in Vercel provider state. `/workspace/result.txt` is saved in the encrypted portable context bundle. To force an ephemeral Vercel sandbox, pass `--runtime-state disabled --no-vercel-persistent`.

Run it in Modal:

```bash
npx contextsdk run employee-robert --runtime modal --create-if-missing -- sh -lc 'echo modal > /workspace/provider.txt'
```

Probe a runtime before using it:

```bash
npx contextsdk probe --runtime e2b
npx contextsdk probe --runtime vercel
npx contextsdk probe --runtime modal
```

Manual lifecycle:

```bash
npx contextsdk session start employee-robert --runtime e2b --create-if-missing
npx contextsdk files write employee-robert workspace/notes.txt "hello" --runtime e2b --sandbox-id <sandbox-id>
npx contextsdk session checkpoint employee-robert --runtime e2b --sandbox-id <sandbox-id> --reason "manual checkpoint"
npx contextsdk session save employee-robert --runtime e2b --sandbox-id <sandbox-id> --message "manual save"
npx contextsdk session end employee-robert --runtime e2b --sandbox-id <sandbox-id> --owner <owner-from-start>
```

Blind retrieval and crash-recovery trials:

```bash
npx contextsdk test blind-retrieval demo --runtime e2b --prompt-out handoff.md --answer-out answer-key.md --execute
npx contextsdk test crash-recovery demo --runtime vercel --execute
```

## SDK example

```ts
import { S3Storage, runWithContext } from "@contextsdk/core";
import { E2BProvisioner } from "@contextsdk/adapter-e2b";

const storage = new S3Storage({
  bucket: "agent-contexts",
  clientConfig: {
    region: "auto",
    endpoint: "https://<account>.r2.cloudflarestorage.com",
    credentials: {
      accessKeyId: process.env.CONTEXTSDK_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.CONTEXTSDK_S3_SECRET_ACCESS_KEY!,
    },
  },
});

await runWithContext({
  id: "agent-123",
  storage,
  encryption: { passphrase: process.env.CONTEXTSDK_PASSPHRASE! },
  provisioner: new E2BProvisioner({ apiKey: process.env.E2B_API_KEY }),
  createIfMissing: true,
  checkpoint: { intervalMs: 300000 },
  message: "agent session",
}, async session => {
  await session.files.write("workspace/task.txt", "current task state\n");
  await session.memory.append("User prefers concise answers.");
  await session.artifacts.write("result.txt", "final artifact\n");
  await session.logs.append("task completed");
});
```

`runWithContext` starts a checkpoint timer when configured. It also tries to save and clean up on `SIGINT` and `SIGTERM`. A hard kill can still lose work after the last checkpoint.

## How each runtime works

E2B:

- Turns the tree bundle into an ext4 image.
- Uploads the image to the sandbox.
- Mounts it with loop devices.
- Checkpoints the mounted tree without unmounting.
- On final save, stores the filtered tree bundle. Explicit ext4 contexts can also update the encrypted ext4 image.

Vercel Sandbox:

- Unpacks the tree bundle into `/vercel/sandbox/contextsdk/<id>`.
- Exposes `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`.
- Saves by creating a tar+zstd bundle in the sandbox, downloading it, encrypting it locally, and uploading it to storage.
- Uses persistent named sandboxes by default, so installed packages, package caches, and build outputs can survive without entering the portable bundle.
- Stores runtime-state metadata in `manifest.json`, including the sandbox name and snapshot IDs when Vercel exposes them.
- Provider persistence and snapshots are accelerators; the encrypted tree bundle remains the portable state.

Modal:

- Uses a Modal Sandbox with a Volume mounted at `/contextsdk` by default.
- Keeps each context in its own subdirectory.
- Runs `sync` before checkpoints and final saves.
- Exports the same encrypted tree bundle so the context can move to another provider.

## Enterprise shape

The enterprise version puts a Context Broker in front of the SDK. The broker decides who can attach which context, enforces one active writer, records audit events, runs DLP or artifact scanning before save, and handles retention or legal hold.

Employees still get a normal agent experience. The platform gets policy, locks, versions, and a storage layout it can inspect.

## Original ext4 validation

The first proof scripts are still here:

```bash
python3 -m venv .venv && . .venv/bin/activate && python -m pip install -e .
export E2B_API_KEY="..."
python scripts/validate_portable_fs.py
python scripts/validate_portable_fs.py --local-to-vm
```

## Checks

```bash
npm run typecheck
npm test
npm run build
npx contextsdk doctor
npx contextsdk run --help
```
