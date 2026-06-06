import { describe, expect, it } from "vitest";
import { ContextLockError } from "../src/errors.js";
import { acquireLock, assertLockOwnership, readLock, releaseLock, renewLock } from "../src/lock.js";
import type { AcquiredLock } from "../src/lock.js";
import { contextKeys } from "../src/paths.js";
import { MemoryStorage } from "../src/storage.js";
import type { ContextLock } from "../src/types.js";

function expiredLock(contextId: string, owner: string): ContextLock {
  const past = new Date(Date.now() - 60_000).toISOString();
  return {
    version: 1,
    contextId,
    owner,
    runtimeId: "runtime-old",
    createdAt: past,
    heartbeatAt: past,
    expiresAt: past,
  };
}

/**
 * Pauses every lock read until two readers arrive, so both takeover candidates
 * observe the same expired lock revision before either attempts to write.
 */
class BarrierStorage extends MemoryStorage {
  private waiting: Array<() => void> = [];
  private gatedReads = 0;
  private readonly expectedReaders = 2;

  async getObjectWithMetadata(key: string) {
    const result = await super.getObjectWithMetadata(key);
    // One-shot barrier: gate only the two contending takeover reads.
    if (key.endsWith("lock.json") && this.gatedReads < this.expectedReaders) {
      this.gatedReads += 1;
      await new Promise<void>(release => {
        this.waiting.push(release);
        if (this.waiting.length >= this.expectedReaders) {
          for (const ready of this.waiting) {
            ready();
          }
          this.waiting = [];
        }
      });
    }
    return result;
  }
}

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

  it("lets exactly one writer take over an expired lock under contention", async () => {
    const storage = new BarrierStorage();
    await storage.putObject(contextKeys("ctx").lock, JSON.stringify(expiredLock("ctx", "owner-stale")));

    const results = await Promise.allSettled([
      acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 60_000 }),
      acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-b", owner: "owner-b", ttlMs: 60_000 }),
    ]);

    const winners = results.filter(result => result.status === "fulfilled");
    const losers = results.filter(result => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContextLockError);

    const lock = await readLock(storage, "ctx");
    const winner = (winners[0] as PromiseFulfilledResult<AcquiredLock>).value;
    expect(lock?.owner).toBe(winner.lock.owner);
    expect(winner.adopted).toBe(false);
  });

  it("refuses expired-lock takeover on adapters that cannot return etags", async () => {
    const backing = new MemoryStorage();
    await backing.putObject(contextKeys("ctx").lock, JSON.stringify(expiredLock("ctx", "owner-stale")));
    // Simulates a third-party adapter without atomic body+etag reads: takeover
    // must fail safe instead of degrading to a blind overwrite.
    const minimal = {
      getObject: backing.getObject.bind(backing),
      putObject: backing.putObject.bind(backing),
      deleteObject: backing.deleteObject.bind(backing),
      headObject: backing.headObject.bind(backing),
    } as unknown as MemoryStorage;

    await expect(acquireLock({ storage: minimal, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 60_000 }))
      .rejects.toThrow(/did not return an etag/);
    // The stale lock is untouched and force still works.
    expect((await readLock(backing, "ctx"))?.owner).toBe("owner-stale");
    await expect(acquireLock({ storage: minimal, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 60_000, force: true }))
      .resolves.toMatchObject({ lock: { owner: "owner-a" }, adopted: false });
  });

  it("renews a held lock and extends its expiry", async () => {
    const storage = new MemoryStorage();
    const original = await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 1_000 });
    const renewed = await renewLock({ storage, contextId: "ctx", owner: "owner-a", ttlMs: 60_000 });
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(original.lock.expiresAt));
    expect((await readLock(storage, "ctx"))?.expiresAt).toBe(renewed.expiresAt);
  });

  it("adopts an unexpired lock held by the same owner instead of refusing", async () => {
    const storage = new MemoryStorage();
    const original = await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 1_000 });
    const reacquired = await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-b", owner: "owner-a", ttlMs: 60_000 });
    expect(reacquired.adopted).toBe(true);
    expect(reacquired.lock.owner).toBe("owner-a");
    expect(reacquired.lock.runtimeId).toBe("runtime-b");
    expect(reacquired.lock.createdAt).toBe(original.lock.createdAt);
    expect(Date.parse(reacquired.lock.expiresAt)).toBeGreaterThan(Date.parse(original.lock.expiresAt));
    // A different owner is still refused while the adopted lock is live.
    await expect(acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-c", owner: "owner-b", ttlMs: 60_000 }))
      .rejects.toThrow(/locked by owner-a/);
  });

  it("refuses renewal once another writer holds the lock", async () => {
    const storage = new MemoryStorage();
    await storage.putObject(contextKeys("ctx").lock, JSON.stringify(expiredLock("ctx", "owner-a")));
    await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-b", owner: "owner-b", ttlMs: 60_000 });
    await expect(renewLock({ storage, contextId: "ctx", owner: "owner-a", ttlMs: 60_000 }))
      .rejects.toThrow(/held by owner-b/);
  });

  it("refuses renewal when the lock is gone", async () => {
    const storage = new MemoryStorage();
    await expect(renewLock({ storage, contextId: "ctx", owner: "owner-a", ttlMs: 60_000 }))
      .rejects.toThrow(/no longer exists/);
  });

  it("asserts lock ownership before context writes", async () => {
    const storage = new MemoryStorage();
    await acquireLock({ storage, contextId: "ctx", runtimeId: "runtime-a", owner: "owner-a", ttlMs: 60_000 });
    await expect(assertLockOwnership({ storage, contextId: "ctx", owner: "owner-a" })).resolves.toBeUndefined();
    await expect(assertLockOwnership({ storage, contextId: "ctx", owner: "owner-b" }))
      .rejects.toThrow(/now locked by owner-a/);
    await releaseLock({ storage, contextId: "ctx", owner: "owner-a" });
    await expect(assertLockOwnership({ storage, contextId: "ctx", owner: "owner-b" })).resolves.toBeUndefined();
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

  it("reports corrupt lock data instead of crashing", async () => {
    const storage = new MemoryStorage();
    await storage.putObject(contextKeys("ctx").lock, "{not json");
    await expect(readLock(storage, "ctx")).rejects.toThrow(/corrupt/);
  });
});
