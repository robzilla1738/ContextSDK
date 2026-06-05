import { describe, expect, it } from "vitest";
import { ObjectNotFoundError, StorageConditionError } from "../src/errors.js";
import { MemoryStorage } from "../src/storage.js";

describe("memory storage", () => {
  it("throws a typed error for missing objects", async () => {
    const storage = new MemoryStorage();
    await expect(storage.getObject("missing")).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.getObjectWithMetadata("missing")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("enforces ifNoneMatch on existing objects", async () => {
    const storage = new MemoryStorage();
    await storage.putObject("key", "first", { ifNoneMatch: "*" });
    await expect(storage.putObject("key", "second", { ifNoneMatch: "*" }))
      .rejects.toBeInstanceOf(StorageConditionError);
    await expect(storage.getObject("key")).resolves.toEqual(Buffer.from("first"));
  });

  it("enforces ifMatch compare-and-swap semantics", async () => {
    const storage = new MemoryStorage();
    await storage.putObject("key", "first");
    const { metadata } = await storage.getObjectWithMetadata("key");
    expect(metadata.etag).toBeTruthy();

    await storage.putObject("key", "second", { ifMatch: metadata.etag });
    // The original etag is now stale; a second CAS with it must fail.
    await expect(storage.putObject("key", "third", { ifMatch: metadata.etag }))
      .rejects.toBeInstanceOf(StorageConditionError);
    await expect(storage.getObject("key")).resolves.toEqual(Buffer.from("second"));
  });

  it("rejects ifMatch puts against missing objects", async () => {
    const storage = new MemoryStorage();
    await expect(storage.putObject("missing", "data", { ifMatch: "etag" }))
      .rejects.toBeInstanceOf(StorageConditionError);
  });

  it("returns matching etags from head and get", async () => {
    const storage = new MemoryStorage();
    await storage.putObject("key", "value");
    const head = await storage.headObject("key");
    const { metadata } = await storage.getObjectWithMetadata("key");
    expect(head?.etag).toBe(metadata.etag);
  });
});
