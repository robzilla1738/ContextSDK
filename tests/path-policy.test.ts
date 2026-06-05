import { describe, expect, it } from "vitest";
import { MountedContextFileManager } from "../src/file-manager.js";
import { normalizeContextPath } from "../src/path-policy.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";

describe("context path policy", () => {
  it("normalizes managed paths", () => {
    expect(normalizeContextPath("/workspace/task.txt")).toBe("workspace/task.txt");
    expect(normalizeContextPath("memory/session.md")).toBe("memory/session.md");
  });

  it("rejects path traversal and unmanaged roots", () => {
    expect(() => normalizeContextPath("../etc/passwd")).toThrow(/invalid context path/);
    expect(() => normalizeContextPath("workspace/../config/secrets")).toThrow(/invalid context path/);
    expect(() => normalizeContextPath("tmp/file")).toThrow(/path must be under/);
  });

  it("maps file manager paths under the mounted context", () => {
    const runtime: RuntimeAdapter = {
      id: "fake",
      async run(): Promise<RuntimeCommandResult> {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async uploadFile(): Promise<void> {},
      async downloadFile(): Promise<void> {},
    };
    const files = new MountedContextFileManager(runtime, "/mnt/context");
    expect(files.resolve("workspace/task.txt")).toBe("/mnt/context/workspace/task.txt");
  });

  it("refuses to remove an entire managed root", async () => {
    const runtime: RuntimeAdapter = {
      id: "fake",
      async run(): Promise<RuntimeCommandResult> {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async uploadFile(): Promise<void> {},
      async downloadFile(): Promise<void> {},
    };
    const files = new MountedContextFileManager(runtime, "/mnt/context");
    await expect(files.remove("workspace")).rejects.toThrow(/refusing to remove managed root/);
  });

  it("uses a portable list command", async () => {
    let command = "";
    const runtime: RuntimeAdapter = {
      id: "fake",
      async run(input: string): Promise<RuntimeCommandResult> {
        command = input;
        return { exitCode: 0, stdout: "task.txt\n", stderr: "" };
      },
      async uploadFile(): Promise<void> {},
      async downloadFile(): Promise<void> {},
    };
    const files = new MountedContextFileManager(runtime, "/mnt/context");
    await expect(files.list("workspace")).resolves.toEqual(["task.txt"]);
    expect(command).toContain("-exec basename {}");
    expect(command).not.toContain("-printf");
  });
});
