# contextSDK

contextSDK gives agents a real filesystem that survives disposable sandboxes.

Most agent runtimes are intentionally temporary. That is good for safety, but awkward for work that needs continuity. contextSDK keeps the VM or sandbox throwaway and stores the agent's working state separately as an encrypted portable bundle.

The default storage object is:

- `contexts/<contextId>/current.tree.tar.zst.enc`

Each context also has:

- `contexts/<contextId>/manifest.json`
- `contexts/<contextId>/lock.json`
- `contexts/<contextId>/checkpoints/<generation>.tree.tar.zst.enc`

E2B and SSH-style runtimes can also keep a raw ext4 image for loop mounting:

- `contexts/<contextId>/current.img.enc`

Inside the runtime, the agent gets the same folders every time: `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`.

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

For a quick trial, environment variables are enough:

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
  checkpoint: {
    intervalMs: 300000,
  },
  providers: {
    vercel: { runtime: "python3.13" },
    modal: { appName: "contextsdk", imageTag: "python:3.13-slim", volumeName: "contextsdk-contexts" },
  },
} satisfies ContextSDKConfig;
```

Provider credentials stay in the environment. The CLI reads `E2B_API_KEY`, Vercel auth, Modal auth, and S3 credentials, but it does not print secret values in `doctor` output.

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

`runWithContext` starts a checkpoint timer when configured. It also tries to save and clean up on `SIGINT` and `SIGTERM`. A hard kill can still lose work after the last checkpoint; that is the honest limit.

## How each runtime works

E2B:

- Turns the tree bundle into an ext4 image.
- Uploads the image to the sandbox.
- Mounts it with loop devices.
- Checkpoints the mounted tree without unmounting.
- On final save, validates ext4 and stores both the tree bundle and ext4 image.

Vercel Sandbox:

- Unpacks the tree bundle into `/vercel/sandbox/contextsdk/<id>`.
- Exposes `/workspace`, `/memory`, `/artifacts`, `/logs`, `/cache`, and `/config`.
- Saves by creating a tar+zstd bundle in the sandbox, downloading it, encrypting it locally, and uploading it to storage.
- Provider snapshots can be useful for warm starts, but the encrypted tree bundle remains the portable state.

Modal:

- Uses a Modal Sandbox with a Volume mounted at `/contextsdk` by default.
- Keeps each context in its own subdirectory.
- Runs `sync` before checkpoints and final saves.
- Exports the same encrypted tree bundle so the context can move to another provider.

## Enterprise shape

The enterprise version is straightforward: put a Context Broker in front of the SDK. The broker decides who can attach which context, enforces one active writer, records audit events, runs DLP or artifact scanning before save, and handles retention or legal hold.

The employee still gets a normal agent experience. The platform gets policy, locks, versions, and a storage layout it can inspect.

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
