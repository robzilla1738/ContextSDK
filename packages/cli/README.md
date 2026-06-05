# @contextsdk/cli

Command-line tool for contextSDK: portable encrypted context state for agent sandboxes and VMs.

```bash
npm install -g @contextsdk/cli
export CONTEXTSDK_PASSPHRASE="choose-a-strong-passphrase"
contextsdk doctor
```

No cloud bucket required. With no S3 configured, contexts live encrypted in a local store at `~/.contextsdk/storage`. Set `CONTEXTSDK_STORAGE_DIR` to pick another directory, or `storage.type: "fs"` plus `directory` in `contextsdk.config.ts`. When an S3 bucket is configured (env or config), S3 wins and is used for multi-machine sharing.

Run a context-backed session:

```bash
export E2B_API_KEY="..."
contextsdk run my-agent \
  --runtime e2b \
  --create-if-missing \
  --checkpoint-interval 5m \
  -- sh -lc 'echo ok > /workspace/result.txt'
```

`run` prints the wrapped command's own stdout and stderr and exits with its exit code. Pass `--json` for the machine-readable envelope (`{ ok, result }`). The passthrough is a breaking change from 0.2.0, which always printed JSON.

## Prerequisites

- Node.js >= 20. The packages are ESM-only (`import`; no `require`).
- A POSIX host: macOS, Linux, or WSL. The CLI shells out to `tar`, `zstd`, and `python3`.
- `e2fsprogs` (`mkfs.ext4`, `e2fsck`) **only** for the optional `--format ext4` contexts. The default tree format never needs it. macOS: `brew install e2fsprogs`.

## Credentials

Encryption is always required: set `CONTEXTSDK_PASSPHRASE`, or `CONTEXTSDK_KEY_HEX` for a raw 32-byte key in hex.

Per-provider credentials are read from the environment, never from argv:

| Runtime | Credentials |
| --- | --- |
| E2B | `E2B_API_KEY` |
| Vercel | `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`, **or** `VERCEL_OIDC_TOKEN` |
| Modal | `~/.modal.toml` (from `modal token new`), or `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` |
| SSH | `--ssh-host` / `--ssh-user` / `--ssh-key`; the remote needs `bash`, `tar`, `zstd`, `python3` |

S3-compatible storage (optional, for multi-machine use) reads `CONTEXTSDK_S3_BUCKET`, `CONTEXTSDK_S3_REGION`, `CONTEXTSDK_S3_ENDPOINT`, `CONTEXTSDK_S3_ACCESS_KEY_ID`, and `CONTEXTSDK_S3_SECRET_ACCESS_KEY`.

## doctor

```bash
contextsdk doctor
```

`doctor` reports the resolved storage backend (`fs` with its directory, or `s3` with the bucket), which credentials it can see (encryption, E2B, Vercel, Modal — including `~/.modal.toml`), and the local tools it found (`tar`, `zstd`, `python3`, and ext4 tooling marked as needed only for `--format ext4`). It never prints secret values.

## Common commands

```bash
contextsdk init my-agent                    # create an encrypted context in storage
contextsdk status my-agent                  # manifest + lock state
contextsdk verify my-agent                  # stored objects exist and are encrypted
contextsdk probe --runtime e2b              # check runtime capabilities
```

Move the same context across providers:

```bash
contextsdk run my-agent --runtime e2b --create-if-missing -- sh -lc 'echo hi > /workspace/state.txt'
contextsdk run my-agent --runtime vercel --vercel-runtime node24 -- sh -lc 'cat /workspace/state.txt'
contextsdk run my-agent --runtime modal -- sh -lc 'cat /workspace/state.txt'
```

Vercel's default runtime image is `python3.13`. For Node work pass `--vercel-runtime node24`.

The CLI bundles the E2B, Vercel, and Modal adapters for trials. For SDK usage, install `@contextsdk/core` and the adapter package you need.

Full docs: https://github.com/robzilla1738/ContextSDK
