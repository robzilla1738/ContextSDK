# E2B Blind Retrieval

Goal: seed a context with synthetic project data, mount it in E2B, and hand another AI only the runtime prompt.

```bash
export E2B_API_KEY="..."
export CONTEXTSDK_S3_BUCKET="agent-contexts"
export CONTEXTSDK_PASSPHRASE="..."

node packages/cli/dist/cli.js test blind-retrieval meridian-demo \
  --runtime e2b \
  --prompt-out handoff-prompt.md \
  --answer-out answer-key.md \
  --execute
```

Give `handoff-prompt.md` to the other AI. Keep `answer-key.md` separate.

Expected result: the other AI finds the missing Northwind Data Trust SOC 2 bridge letter and cites files under `/memory`, `/workspace`, and `/artifacts`.
