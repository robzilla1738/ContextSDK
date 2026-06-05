import { defaultLayout } from "./paths.js";
import type { ContextPersistencePolicy } from "./types.js";

export const defaultPersistencePolicy: ContextPersistencePolicy = {
  roots: defaultLayout.filter(root => root !== "cache"),
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
};

export function resolvePersistencePolicy(policy?: Partial<ContextPersistencePolicy>): ContextPersistencePolicy {
  return {
    roots: policy?.roots?.length ? [...policy.roots] : [...defaultPersistencePolicy.roots],
    exclude: policy?.exclude?.length ? [...policy.exclude] : [...defaultPersistencePolicy.exclude],
  };
}
