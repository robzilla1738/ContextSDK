# Crash Recovery Checkpoint

Goal: verify that recovery falls back to the latest checkpoint when final teardown is interrupted.

```bash
node packages/cli/dist/cli.js test crash-recovery crash-demo --runtime vercel --execute
node packages/cli/dist/cli.js versions list crash-demo
node packages/cli/dist/cli.js run crash-demo --runtime vercel -- sh -lc 'cat /workspace/recovery.txt'
```

Expected result: `versions list` reports a latest checkpoint, and the next run restores the checkpointed marker.

Hard kills cannot be perfectly durable. contextSDK recovers to the latest completed checkpoint, plus any graceful final save that finished before the runtime died.
