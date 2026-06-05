# @contextsdk/adapter-e2b

E2B runtime adapter for contextSDK. Built on the e2b SDK v2 (`e2b@^2.27`).

Use this when you want contextSDK to attach an encrypted portable context to an E2B sandbox. Tree contexts (the default) attach through the unprivileged directory-bundle path, so no host ext4 tooling is required. `mkfs.ext4`/`e2fsck` are only needed for explicit `--format ext4` contexts.

`@contextsdk/core` is a peer dependency — install both (npm 7+ installs the peer automatically):

```bash
npm install @contextsdk/core @contextsdk/adapter-e2b
```

```ts
import { FsStorage, runWithContext } from "@contextsdk/core";
import { E2BProvisioner } from "@contextsdk/adapter-e2b";

const storage = new FsStorage({ directory: `${process.env.HOME}/.contextsdk/storage` });

await runWithContext({
  id: "agent-context",
  storage,
  encryption: { passphrase: process.env.CONTEXTSDK_PASSPHRASE! },
  provisioner: new E2BProvisioner({ apiKey: process.env.E2B_API_KEY }),
  createIfMissing: true,
}, async session => {
  await session.files.write("workspace/result.txt", "ok\n");
});
```

Sandboxes default to a 30-minute lifetime (`defaultSandboxTimeoutMs`) instead of E2B's 5-minute default, and the session heartbeat calls `keepAlive()` to reset that countdown while a session is actively running. Presigned-URL uploads and downloads retry with backoff on connect timeouts and 5xx/429/408 responses, so fresh-sandbox ingress flakiness does not fail attach. Remote commands run with a 15-minute default timeout.

Full docs: https://github.com/robzilla1738/ContextSDK
