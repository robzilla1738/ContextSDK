import type { ContextSDKConfig } from "@contextsdk/core";

export default {
  storage: {
    type: "s3",
    bucket: "agent-contexts",
    region: "auto",
    endpoint: "https://<account>.r2.cloudflarestorage.com",
    forcePathStyle: true,
  },
  encryption: {
    passphraseEnv: "CONTEXTSDK_PASSPHRASE",
  },
  defaultRuntime: "e2b",
  defaultFormat: "tree",
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
    },
    modal: {
      appName: "contextsdk",
      imageTag: "python:3.13-slim",
      volumeName: "contextsdk-contexts",
      volumeSubPath: "tenant-a",
      timeoutMs: 600000,
    },
  },
} satisfies ContextSDKConfig;
