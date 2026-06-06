# Vercel Agent Workspace

Goal: unpack the encrypted context into a Vercel Sandbox, write portable context files, and keep dependency-heavy runtime state in Vercel's persistent named sandbox.

The Vercel Sandbox default runtime image is `python3.13`, so any Node workload must pass a Node runtime (`--vercel-runtime node24`):

```bash
contextsdk run vercel-demo \
  --runtime vercel \
  --vercel-runtime node24 \
  --create-if-missing \
  --checkpoint-interval 5m \
  -- sh -lc 'cd /workspace && npm init -y >/dev/null && npm install is-odd >/dev/null && echo "vercel state" > /workspace/result.txt && echo "remember vercel" >> /memory/session.md'

contextsdk run vercel-demo \
  --runtime vercel \
  --vercel-runtime node24 \
  -- sh -lc 'test -d /workspace/node_modules && cat /workspace/result.txt && tail -n 1 /memory/session.md'
```

Expected result: the second run resumes the same named Vercel sandbox (`contextsdk-vercel-demo`), sees `/workspace/node_modules` from provider runtime state, and reads `/workspace/result.txt` plus `/memory/session.md` from the encrypted portable context.

Use `--runtime-state disabled --no-vercel-persistent` when you want an ephemeral Vercel sandbox for a test.
