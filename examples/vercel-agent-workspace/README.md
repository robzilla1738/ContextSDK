# Vercel Agent Workspace

Goal: unpack the encrypted tree bundle directly into a Vercel Sandbox directory, write state, save, then read it from a second sandbox.

```bash
npx contextsdk run vercel-demo \
  --runtime vercel \
  --create-if-missing \
  --checkpoint-interval 5m \
  -- sh -lc 'echo "vercel state" > /workspace/result.txt && echo "remember vercel" >> /memory/session.md'

npx contextsdk run vercel-demo \
  --runtime vercel \
  -- sh -lc 'cat /workspace/result.txt && tail -n 1 /memory/session.md'
```

Expected result: the second run reads the file written by the first run.
