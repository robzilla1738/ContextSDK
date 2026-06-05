import { describe, expect, it } from "vitest";
import { acquireLock, releaseLock } from "../src/lock.js";
import { MemoryStorage } from "../src/storage.js";

describe("locks", () => {
  it("refuses concurrent active attach locks", async () => {
    const storage = new MemoryStorage();
    await acquireLock({
      storage,
      contextId: "ctx",
      runtimeId: "runtime-a",
      owner: "owner-a",
      ttlMs: 60_000,
    });
    await expect(acquireLock({
      storage,
      contextId: "ctx",
      runtimeId: "runtime-b",
      owner: "owner-b",
      ttlMs: 60_000,
    })).rejects.toThrow(/locked by owner-a/);
  });

  it("allows forced unlock release", async () => {
    const storage = new MemoryStorage();
    await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 60_000 });
    await releaseLock({ storage, contextId: "ctx", owner: "owner-b", force: true });
    await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-b", owner: "owner-b", ttlMs: 60_000 });
  });

  it("does not release a lock without the matching owner", async () => {
    const storage = new MemoryStorage();
    await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 60_000 });
    await expect(releaseLock({ storage, contextId: "ctx" })).rejects.toThrow(/cannot release lock owned by owner-a/);
  });
});
