# Contributing

Thanks for helping improve contextSDK.

## Setup

```bash
git clone https://github.com/robzilla1738/ContextSDK.git
cd ContextSDK
npm install
```

Prerequisites: Node >= 20 and a POSIX environment with `tar`, `zstd`, and
`python3` (macOS, Linux, or WSL). `e2fsprogs` (`mkfs.ext4`, `e2fsck`) is only
needed if you work on the ext4 format paths.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
node packages/cli/dist/cli.js doctor
git diff --check
```

Add tests for behavior changes — especially persistence policy, versioning,
locks, runtime adapters, and CLI command construction. Prefer existing project
patterns over new abstractions, and keep changes scoped.

## Repository layout

- `src/` — `@contextsdk/core` source (built into `packages/core`).
- `packages/` — the five published npm packages.
- `tests/` — vitest suites.
- `examples/` — runnable scenario docs.

## Security issues

Never open a public issue for an exploitable bug — see [SECURITY.md](SECURITY.md).
