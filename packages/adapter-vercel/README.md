# @contextsdk/adapter-vercel

Vercel Sandbox runtime adapter for contextSDK.

Use this when you want portable encrypted context files plus Vercel provider persistence for dependency-heavy runtime state.

```bash
npm install @contextsdk/core @contextsdk/adapter-vercel
```

By default, the adapter uses a persistent named sandbox such as `contextsdk-<contextId>`. The context bundle stays portable in cloud storage; installed packages and build caches stay in Vercel runtime state.

```ts
import { runWithContext } from "@contextsdk/core";
import { VercelProvisioner } from "@contextsdk/adapter-vercel";

await runWithContext({
  id: "agent-context",
  storage,
  encryption,
  provisioner: new VercelProvisioner(),
  createIfMissing: true,
}, async session => {
  await session.files.write("workspace/result.txt", "ok\n");
});
```

Full docs: https://github.com/robzilla1738/ContextSDK
