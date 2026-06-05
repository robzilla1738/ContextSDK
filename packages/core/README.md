# @contextsdk/core

Core SDK for contextSDK.

It handles encrypted context bundles, S3-compatible storage, locks, manifests, checkpoints, version metadata, file APIs, and the runtime adapter contract.

```bash
npm install @contextsdk/core
```

```ts
import { S3Storage, runWithContext } from "@contextsdk/core";
```

Install a runtime adapter separately:

```bash
npm install @contextsdk/adapter-vercel
npm install @contextsdk/adapter-e2b
npm install @contextsdk/adapter-modal
```

Full docs: https://github.com/robzilla1738/ContextSDK
