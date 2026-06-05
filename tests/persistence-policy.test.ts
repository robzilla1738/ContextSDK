import { describe, expect, it } from "vitest";
import { defaultPersistencePolicy } from "../src/persistence-policy.js";
import { packBundleScript, unpackBundleScript } from "../src/scripts.js";

describe("persistence policy", () => {
  it("defaults to user and agent context roots, not runtime caches", () => {
    expect(defaultPersistencePolicy.roots).toEqual(["workspace", "memory", "artifacts", "logs", "config"]);
    expect(defaultPersistencePolicy.roots).not.toContain("cache");
    expect(defaultPersistencePolicy.exclude).toEqual(expect.arrayContaining([
      "**/node_modules/**",
      "**/.pnpm-store/**",
      "**/.npm/**",
      "**/.yarn/cache/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/.venv/**",
      "**/__pycache__/**",
    ]));
  });

  it("passes the policy to runtime bundle packing", () => {
    const script = packBundleScript("/tmp/context.tree.tar.zst", "/mnt/contextsdk/demo");

    expect(script).toContain('"roots":["workspace","memory","artifacts","logs","config"]');
    expect(script).toContain("**/node_modules/**");
    expect(script).toContain("tarfile.open");
    expect(script).not.toContain('"cache"');
  });

  it("unpacks by replacing portable roots without deleting provider runtime state", () => {
    const script = unpackBundleScript("/tmp/context.tree.tar.zst", "/mnt/contextsdk/demo");

    expect(script).not.toContain("rm -rf \"$mountpoint\"");
    expect(script).toContain("shutil.rmtree(path)");
    expect(script).toContain('"roots":["workspace","memory","artifacts","logs","config"]');
    expect(script).not.toContain('"cache"');
  });
});
