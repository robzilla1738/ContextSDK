# @contextsdk/cli

Command-line tool for contextSDK.

```bash
npm install -g @contextsdk/cli
contextsdk doctor
```

Run a context-backed session:

```bash
contextsdk run employee-robert \
  --runtime vercel \
  --create-if-missing \
  --checkpoint-interval 5m \
  -- sh -lc 'echo ok > /workspace/result.txt'
```

The CLI includes the E2B, Vercel, and Modal adapters for trials. For SDK usage, install `@contextsdk/core` and the adapter package you need.

Full docs: https://github.com/robzilla1738/ContextSDK
