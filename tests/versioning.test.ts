import { describe, expect, it } from "vitest";
import { diffVersionFiles } from "../src/versioning.js";
import type { ContextFileEntry } from "../src/types.js";

function file(path: string, sha256: string): ContextFileEntry {
  return { path, sha256, size: 1, mode: "0o644", mtime: "2026-01-01T00:00:00Z" };
}

describe("version diffing", () => {
  it("detects added, modified, and removed files", () => {
    expect(diffVersionFiles(
      [file("workspace/a.txt", "a"), file("memory/old.md", "old"), file("logs/stable.log", "same")],
      [file("workspace/a.txt", "b"), file("artifacts/new.txt", "new"), file("logs/stable.log", "same")],
    )).toEqual([
      { path: "artifacts/new.txt", type: "added" },
      { path: "workspace/a.txt", type: "modified" },
      { path: "memory/old.md", type: "removed" },
    ]);
  });
});
