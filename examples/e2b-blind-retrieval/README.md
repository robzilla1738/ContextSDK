# E2B Blind Retrieval

Goal: seed a context with synthetic project data, mount it in E2B, and hand another AI only the runtime prompt.

No S3 bucket is required: with `CONTEXTSDK_S3_*` unset, the context lives in the local store at `~/.contextsdk/storage`. Set the S3 variables only when you want shared, multi-machine storage.

```bash
export E2B_API_KEY="..."
export CONTEXTSDK_PASSPHRASE="..."
# Optional, for shared storage:
# export CONTEXTSDK_S3_BUCKET="agent-contexts"

contextsdk test blind-retrieval meridian-demo \
  --runtime e2b \
  --prompt-out handoff-prompt.md \
  --answer-out answer-key.md \
  --execute
```

Give `handoff-prompt.md` to the other AI. Keep `answer-key.md` separate.

Expected result: the other AI finds the missing Northwind Data Trust SOC 2 bridge letter and cites files under `/memory`, `/workspace`, and `/artifacts`.
