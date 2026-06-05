# Modal Volume Session

Goal: mount a Modal Volume-backed context directory while still exporting the portable encrypted tree bundle to S3-compatible storage.

```bash
npx contextsdk run modal-demo \
  --runtime modal \
  --modal-app contextsdk \
  --modal-volume contextsdk-contexts \
  --modal-volume-subpath tenant-a \
  --create-if-missing \
  -- sh -lc 'echo "modal state" > /workspace/provider.txt'

npx contextsdk run modal-demo \
  --runtime modal \
  --modal-app contextsdk \
  --modal-volume contextsdk-contexts \
  --modal-volume-subpath tenant-a \
  -- sh -lc 'cat /workspace/provider.txt'
```

Expected result: Modal's Volume improves provider-local continuity, while the encrypted tree bundle remains the portable source of truth.
