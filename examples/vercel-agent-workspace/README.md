# Vercel Agent Workspace

Goal: unpack the encrypted context into a Vercel Sandbox, write portable context files, and keep dependency-heavy runtime state in Vercel's persistent named sandbox.

```bash
npx contextsdk run vercel-demo \
  --runtime vercel \
  --create-if-missing \
  --checkpoint-interval 5m \
  -- sh -lc 'npm init -y >/dev/null && npm install is-odd >/dev/null && echo "vercel state" > /workspace/result.txt && echo "remember vercel" >> /memory/session.md'

npx contextsdk run vercel-demo \
  --runtime vercel \
  -- sh -lc 'test -d node_modules && cat /workspace/result.txt && tail -n 1 /memory/session.md'
```

Expected result: the second run resumes the same named Vercel sandbox, sees `node_modules` from provider state, and reads `/workspace/result.txt` plus `/memory/session.md` from the encrypted portable context.

Use `--runtime-state disabled --no-vercel-persistent` when you want an ephemeral Vercel sandbox for a test.
