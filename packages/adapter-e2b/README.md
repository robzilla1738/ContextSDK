# @contextsdk/adapter-e2b

E2B runtime adapter for contextSDK.

Use this when you want contextSDK to attach an encrypted portable context to an E2B sandbox using the loop-mounted ext4 flow.

```bash
npm install @contextsdk/core @contextsdk/adapter-e2b
```

```ts
import { runWithContext } from "@contextsdk/core";
import { E2BProvisioner } from "@contextsdk/adapter-e2b";

await runWithContext({
  id: "agent-context",
  storage,
  encryption,
  provisioner: new E2BProvisioner({ apiKey: process.env.E2B_API_KEY }),
  createIfMissing: true,
}, async session => {
  await session.files.write("workspace/result.txt", "ok\n");
});
```

Full docs: https://github.com/robzilla1738/ContextSDK
