# Modal Volume Session

Goal: use a Modal Volume-backed context directory while still exporting the encrypted portable bundle to storage. With no S3 bucket configured the bundle lands in the local store (`~/.contextsdk/storage`); set `CONTEXTSDK_S3_*` for shared S3-compatible storage.

```bash
contextsdk run modal-demo \
  --runtime modal \
  --modal-app contextsdk \
  --modal-volume contextsdk-contexts \
  --modal-volume-subpath tenant-a \
  --create-if-missing \
  -- sh -lc 'echo "modal state" > /workspace/provider.txt'

contextsdk run modal-demo \
  --runtime modal \
  --modal-app contextsdk \
  --modal-volume contextsdk-contexts \
  --modal-volume-subpath tenant-a \
  -- sh -lc 'cat /workspace/provider.txt'
```

Expected result: the Modal Volume improves provider-local continuity, while the encrypted tree bundle remains the portable source of truth.
