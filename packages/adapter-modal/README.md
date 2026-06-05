# @contextsdk/adapter-modal

Modal Sandbox and Volume runtime adapter for contextSDK.

Use this when you want a Modal sandbox with a context directory backed by a Modal Volume, while still exporting the encrypted portable context bundle to your storage backend so the context can move to another provider.

`@contextsdk/core` is a peer dependency (npm 7+ installs it automatically):

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

## Credentials

The Modal client reads `~/.modal.toml` (created by `modal token new`) or the `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` environment variables.

## Runtime behavior

- The context directory is backed by a Modal Volume mounted at `/contextsdk` (override with `volumeMountPath`), one subdirectory per context. The volume accelerates re-attach; the encrypted tree bundle remains the portable source of truth and is still exported on save.
- Sandboxes default to a 60-minute lifetime (`timeoutMs`), since Modal otherwise terminates them 5 minutes after creation. Modal's JS SDK has no extend-at-runtime API, so size `timeoutMs` to the workload up front (Modal caps it at 24 hours). Pass `idleTimeoutMs` to terminate the sandbox after a period of exec inactivity, independent of `timeoutMs`.
- `dispose()` only terminates sandboxes the adapter created. A sandbox you supply via `sandbox` or reattach to via `sandboxId` belongs to your lifecycle and is left running.

Full docs: https://github.com/robzilla1738/ContextSDK
