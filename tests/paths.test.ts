import { describe, expect, it } from "vitest";
import { contextKeys, defaultMountPath, remoteImagePath } from "../src/paths.js";

describe("context paths", () => {
  it("uses stable S3-compatible key names", () => {
    expect(contextKeys("user-123")).toEqual({
      image: "contexts/user-123/current.img.enc",
      tree: "contexts/user-123/current.tree.tar.zst.enc",
      manifest: "contexts/user-123/manifest.json",
      lock: "contexts/user-123/lock.json",
      checkpoints: "contexts/user-123/checkpoints",
    });
  });

  it("sanitizes runtime paths", () => {
    expect(remoteImagePath("user/context")).toBe("/tmp/contextsdk-user-context.ext4.img");
    expect(defaultMountPath("user/context")).toBe("/mnt/contextsdk/user-context");
  });
});
