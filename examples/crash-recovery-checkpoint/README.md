# Crash Recovery Checkpoint

Goal: verify that a hard sandbox crash loses only uncheckpointed work, and that recovery restores the latest checkpoint.

```bash
contextsdk test crash-recovery crash-demo --runtime vercel --execute
contextsdk versions list crash-demo
contextsdk run crash-demo --runtime vercel -- sh -lc 'ls /workspace'
```

With `--execute`, the scenario checkpoints a marker (`workspace/recovery-checkpointed.txt`), writes a second marker (`workspace/recovery-lost.txt`) **without** checkpointing it, hard-kills the sandbox via the adapter's `kill()`, re-attaches on a fresh sandbox reusing the crashed session's lock owner (no TTL wait), and asserts:

- the checkpointed marker survived, and
- the uncheckpointed marker was lost with the crash.

The command prints a JSON verdict per phase and exits non-zero on failure.

Add `--auto-recovery` to also exercise the `runWithContext` recovery driver end-to-end: the session callback kills its own sandbox mid-run, and the SDK must re-provision, restore the checkpoint, and re-invoke the callback (`recovery: { enabled: true, reinvoke: true }`).

```bash
contextsdk test crash-recovery crash-demo --runtime vercel --execute --auto-recovery
```

Hard kills cannot be perfectly durable. contextSDK recovers to the latest completed checkpoint, plus any graceful final save that finished before the runtime died.
