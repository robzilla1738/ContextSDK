import type { ContextSDKConfig } from "@contextsdk/core";

export default {
  // S3-compatible object storage for shared, multi-machine use.
  storage: {
    type: "s3",
    bucket: "agent-contexts",
    region: "auto",
    endpoint: "https://<account>.r2.cloudflarestorage.com",
    forcePathStyle: true,
  },
  // Local directory store — no cloud bucket required. Omitting `directory`
  // uses ~/.contextsdk/storage; CONTEXTSDK_STORAGE_DIR also relocates it.
  // Note: paths are used verbatim (no "~" expansion).
  // storage: {
  //   type: "fs",
  //   directory: "/srv/agent-contexts",
  // },
  encryption: {
    passphraseEnv: "CONTEXTSDK_PASSPHRASE",
  },
  defaultRuntime: "e2b",
  defaultFormat: "tree",
  runtimeState: "auto",
  persistence: {
    roots: ["workspace", "memory", "artifacts", "logs", "config"],
    exclude: [
      "**/node_modules/**",
      "**/.pnpm-store/**",
      "**/.npm/**",
      "**/.yarn/cache/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/.venv/**",
      "**/__pycache__/**",
    ],
  },
  checkpoint: {
    intervalMs: 300000,
    enabled: true,
  },
  providers: {
    e2b: {
      timeoutMs: 600000,
    },
    vercel: {
      runtime: "python3.13",
      timeoutMs: 600000,
      vcpus: 2,
      persistent: true,
      snapshotExpirationMs: 14 * 24 * 60 * 60 * 1000,
      keepLastSnapshots: 3,
    },
    modal: {
      appName: "contextsdk",
      imageTag: "python:3.13-slim",
      volumeName: "contextsdk-contexts",
      volumeSubPath: "tenant-a",
      timeoutMs: 600000,
      idleTimeoutMs: 60000,
    },
  },
} satisfies ContextSDKConfig;
