# Crash Recovery Checkpoint

Goal: verify recovery is bounded by the latest checkpoint when final teardown is interrupted.

```bash
npx contextsdk test crash-recovery crash-demo --runtime vercel --execute
npx contextsdk versions list crash-demo
npx contextsdk run crash-demo --runtime vercel -- sh -lc 'cat /workspace/recovery.txt'
```

Expected result: `versions list` reports a latest checkpoint, and the next run restores the checkpointed marker.

Hard kills cannot be made perfectly durable; contextSDK guarantees recovery to the latest completed checkpoint plus graceful final saves.
