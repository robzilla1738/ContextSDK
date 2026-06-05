import type { ContextFormat, ContextPersistencePolicy, RuntimeProvider } from "./types.js";

export interface ContextSDKConfig {
  storage?: {
    /** "s3" for S3-compatible object storage; "fs" for a local directory store. */
    type?: "s3" | "fs";
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    /** Object directory for type "fs". Defaults to ~/.contextsdk/storage. */
    directory?: string;
  };
  encryption?: {
    passphraseEnv?: string;
    rawKeyHexEnv?: string;
  };
  defaultRuntime?: RuntimeProvider | string;
  defaultFormat?: ContextFormat;
  checkpoint?: {
    intervalMs?: number;
    enabled?: boolean;
  };
  persistence?: Partial<ContextPersistencePolicy>;
  runtimeState?: "auto" | "disabled";
  providers?: {
    e2b?: Record<string, unknown>;
    vercel?: Record<string, unknown>;
    modal?: Record<string, unknown>;
    ssh?: Record<string, unknown>;
  };
}
