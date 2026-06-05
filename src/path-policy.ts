import { ContextSDKError } from "./errors.js";

const managedRoots = new Set(["workspace", "memory", "artifacts", "logs", "cache", "config", ".contextsdk"]);

export function normalizeContextPath(input = "workspace"): string {
  const withoutLeadingSlash = input.replace(/^\/+/, "");
  const parts = withoutLeadingSlash.split("/").filter(Boolean);
  if (parts.length === 0) {
    return "workspace";
  }
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\0")) {
      throw new ContextSDKError(`invalid context path: ${input}`);
    }
  }
  if (!managedRoots.has(parts[0])) {
    throw new ContextSDKError(`path must be under one of: ${[...managedRoots].join(", ")}`);
  }
  return parts.join("/");
}

export function remoteContextPath(mountPath: string, input: string): string {
  return `${mountPath.replace(/\/+$/g, "")}/${normalizeContextPath(input)}`;
}
