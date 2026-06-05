# Cross-Provider E2B to Vercel

Goal: prove that the same encrypted context can move between providers.

```bash
npx contextsdk run cross-provider-demo \
  --runtime e2b \
  --create-if-missing \
  -- sh -lc 'echo "written in e2b" > /workspace/provider-hop.txt'

npx contextsdk run cross-provider-demo \
  --runtime vercel \
  -- sh -lc 'cat /workspace/provider-hop.txt && echo "read in vercel" >> /memory/session.md'
```

Expected result: Vercel reads state written by E2B because both providers use `current.tree.tar.zst.enc` as the portable source of truth.
