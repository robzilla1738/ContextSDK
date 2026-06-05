# @contextsdk/adapter-vercel

Vercel Sandbox runtime adapter for contextSDK.

Use this when you want portable encrypted context files plus Vercel provider persistence for dependency-heavy runtime state.

```bash
npm install @contextsdk/core @contextsdk/adapter-vercel
```

`@contextsdk/core` is a peer dependency (npm 7+ installs it automatically).

By default, the adapter uses a persistent named sandbox such as `contextsdk-<contextId>`. The context bundle stays portable in cloud storage; installed packages and build caches stay in Vercel runtime state.

```ts
import { runWithContext } from "@contextsdk/core";
import { VercelProvisioner } from "@contextsdk/adapter-vercel";

await runWithContext({
  id: "agent-context",
  storage,
  encryption,
  provisioner: new VercelProvisioner({ runtime: "node24" }),
  createIfMissing: true,
}, async session => {
  await session.files.write("workspace/result.txt", "ok\n");
});
```

## Runtime image

The default runtime image is `python3.13`. For npm/Node workloads, pass a Node image (`runtime: "node24"`, or `--vercel-runtime node24` from the CLI); otherwise `npm` and `node` are not on the path.

## Headless auth

For non-interactive use, pass a Vercel API token together with its team and project:

```ts
new VercelProvisioner({ token, teamId, projectId, runtime: "node24" })
```

The SDK requires all three together. Without them it falls back to `VERCEL_OIDC_TOKEN` (`vercel link` + `vercel env pull`) or an interactive login. The CLI also reads `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` from the environment.

## Sandbox lifetime

Sandboxes default to a 45-minute timeout (`timeoutMs`) instead of Vercel's 5-minute default. The adapter implements `keepAlive()`, which the session heartbeat calls to `extendTimeout` and reset the stop countdown while a session is actively running.

## Snapshots

Stopped persistent sandboxes keep their snapshot for 14 days by default (`snapshotExpirationMs`). After expiry the sandbox comes back empty — the portable context is still restored from cloud storage, but Vercel runtime state (installed packages, build output) is gone.

## Commands

`session.run(cmd, { user })` accepts only `root` or `vercel-sandbox`; any other user is rejected. `root` runs the command via `sudo`.

Full docs: https://github.com/robzilla1738/ContextSDK
