# @contextsdk/adapter-modal

Modal Sandbox and Volume runtime adapter for contextSDK.

Use this when you want a Modal sandbox with a context directory backed by a Modal Volume, while still exporting the encrypted portable context bundle to S3-compatible storage.

```bash
npm install @contextsdk/core @contextsdk/adapter-modal
```

```ts
import { runWithContext } from "@contextsdk/core";
import { ModalProvisioner } from "@contextsdk/adapter-modal";

await runWithContext({
  id: "agent-context",
  storage,
  encryption,
  provisioner: new ModalProvisioner({
    volumeName: "contextsdk-contexts",
  }),
  createIfMissing: true,
}, async session => {
  await session.files.write("workspace/result.txt", "ok\n");
});
```

Full docs: https://github.com/robzilla1738/ContextSDK
