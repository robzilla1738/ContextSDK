# Concurrent Lock Denial

Goal: prove that only one runtime can write to a context at a time.

Start a session and keep its owner/lock active:

```bash
contextsdk session start lock-demo --runtime e2b --create-if-missing
```

In another terminal, try to attach the same context:

```bash
contextsdk attach lock-demo --runtime vercel
```

Expected result: the second attach fails because `contexts/lock-demo/lock.json` exists and has not expired.

Only use `--force-unlock` when an operator has confirmed the prior runtime is dead or intentionally abandoned.
