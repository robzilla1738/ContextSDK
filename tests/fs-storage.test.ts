import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStorage } from "../src/fs-storage.js";
import { ObjectNotFoundError, StorageConditionError } from "../src/errors.js";

describe("FsStorage", () => {
  let dir: string;
  let storage: FsStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextsdk-fs-storage-"));
    storage = new FsStorage({ directory: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips objects with nested keys and content-hash etags", async () => {
    await storage.putObject("contexts/demo/manifest.json", "{}");
    await expect(storage.getObject("contexts/demo/manifest.json")).resolves.toEqual(Buffer.from("{}"));
    const head = await storage.headObject("contexts/demo/manifest.json");
    expect(head?.etag).toMatch(/^[0-9a-f-]{36}$/);

    await storage.putObject("contexts/demo/manifest.json", "{\"v\":2}");
    const updated = await storage.headObject("contexts/demo/manifest.json");
    expect(updated?.etag).not.toBe(head?.etag);

    await storage.deleteObject("contexts/demo/manifest.json");
    await expect(storage.getObject("contexts/demo/manifest.json")).rejects.toThrow(ObjectNotFoundError);
    await expect(storage.headObject("contexts/demo/manifest.json")).resolves.toBeNull();
  });

  it("enforces ifNoneMatch create-only semantics", async () => {
    await storage.putObject("lock.json", "a", { ifNoneMatch: "*" });
    await expect(storage.putObject("lock.json", "b", { ifNoneMatch: "*" })).rejects.toThrow(StorageConditionError);
    await expect(storage.getObject("lock.json")).resolves.toEqual(Buffer.from("a"));
  });

  it("enforces ifMatch compare-and-swap so exactly one racing writer wins", async () => {
    await storage.putObject("lock.json", "original");
    const { metadata } = await storage.getObjectWithMetadata("lock.json");
    const results = await Promise.allSettled([
      storage.putObject("lock.json", "writer-one", { ifMatch: metadata.etag }),
      storage.putObject("lock.json", "writer-two", { ifMatch: metadata.etag }),
    ]);
    const winners = results.filter(result => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const body = (await storage.getObject("lock.json")).toString();
    expect(["writer-one", "writer-two"]).toContain(body);
  });

  it("rejects ifMatch against a missing or changed object", async () => {
    await expect(storage.putObject("gone.json", "x", { ifMatch: "etag" })).rejects.toThrow(StorageConditionError);
    await storage.putObject("present.json", "current");
    await expect(storage.putObject("present.json", "x", { ifMatch: "stale" })).rejects.toThrow(StorageConditionError);
  });

  it("gives identical content distinct etags so CAS is ABA-safe", async () => {
    await storage.putObject("k", "same");
    const first = (await storage.headObject("k"))!.etag;
    await storage.putObject("k", "different");
    await storage.putObject("k", "same");
    const third = (await storage.headObject("k"))!.etag;
    // Content returned to its original bytes, but a stale ifMatch must still fail.
    expect(third).not.toBe(first);
    await expect(storage.putObject("k", "x", { ifMatch: first })).rejects.toThrow(StorageConditionError);
  });

  it("lists keys under a prefix without internal bookkeeping files", async () => {
    await storage.putObject("contexts/a/tree/1.enc", "x");
    await storage.putObject("contexts/a/tree/2.enc", "y");
    await storage.putObject("contexts/a/manifest.json", "{}");
    const keys = await storage.listObjects("contexts/a/tree/");
    expect(keys.sort()).toEqual(["contexts/a/tree/1.enc", "contexts/a/tree/2.enc"]);
    expect(keys.some(k => k.includes(".etagid") || k.includes(".lock"))).toBe(false);
  });

  it("rejects keys that escape the storage directory", async () => {
    await expect(storage.putObject("../escape.json", "x")).rejects.toThrow(/escapes the storage directory/);
  });
});
