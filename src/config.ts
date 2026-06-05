import type { ContextFormat, RuntimeProvider } from "./types.js";

export interface ContextSDKConfig {
  storage?: {
    type?: "s3";
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
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
  providers?: {
    e2b?: Record<string, unknown>;
    vercel?: Record<string, unknown>;
    modal?: Record<string, unknown>;
    ssh?: Record<string, unknown>;
  };
}
