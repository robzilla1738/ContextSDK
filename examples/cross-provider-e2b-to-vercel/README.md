# Cross-Provider E2B to Vercel

Goal: prove that the same encrypted context can move between providers.

```bash
contextsdk run cross-provider-demo \
  --runtime e2b \
  --create-if-missing \
  -- sh -lc 'echo "written in e2b" > /workspace/provider-hop.txt'

contextsdk run cross-provider-demo \
  --runtime vercel \
  -- sh -lc 'cat /workspace/provider-hop.txt && echo "read in vercel" >> /memory/session.md'
```

Expected result: Vercel reads state written by E2B because both providers share the same encrypted tree bundle as the portable source of truth. The bundle is stored under a generation-scoped key (`contexts/cross-provider-demo/tree/<generation>-<attempt>.tree.tar.zst.enc`) that the manifest commit points at.

No S3 bucket is required: without one, the context lives in the local store at `~/.contextsdk/storage`.
