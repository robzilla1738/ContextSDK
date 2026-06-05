import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext, readManifest, runWithContext, saveContext } from "../src/context.js";
import { decryptFile } from "../src/crypto.js";
import { ContextLockError, ContextSDKError } from "../src/errors.js";
import { MemoryStorage } from "../src/storage.js";
import type { ObjectMetadata, PutObjectOptions } from "../src/storage.js";
import type { RuntimeAdapter, RuntimeCommandResult } from "../src/runtime.js";

const encryption = { passphrase: "passphrase", scrypt: { cost: 1024, blockSize: 8, parallelization: 1 } };

class FakeRuntime implements RuntimeAdapter {
  id = "fake-runtime";
  capabilities = { directoryBundle: true, loopExt4: false };
  commands: string[] = [];
  private payload?: Buffer;

  async run(command: string): Promise<RuntimeCommandResult> {
    this.commands.push(command);
    if (command.includes("CONTEXTSDK_VERSION_JSON")) {
      return {
        exitCode: 0,
        stdout: `CONTEXTSDK_VERSION_JSON=${JSON.stringify({
          version: 1,
          generation: 2,
          parentGeneration: 1,
          timestamp: "2026-01-01T00:00:00Z",
          author: "tester",
          message: "save",
          changedPaths: [],
          files: [],
        })}\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async uploadFile(localPath: string): Promise<void> {
    this.payload = await readFile(localPath);
  }

  async downloadFile(_remotePath: string, localPath: string): Promise<void> {
    await writeFile(localPath, this.payload ?? Buffer.from("placeholder"));
  }
}

async function expectDecryptable(storage: MemoryStorage, id: string): Promise<void> {
  const manifest = await readManifest(storage, id);
  const dir = await mkdtemp(join(tmpdir(), "contextsdk-verify-"));
  try {
    const encrypted = join(dir, "bundle.enc");
    const plain = join(dir, "bundle");
    await writeFile(encrypted, await storage.getObject(manifest.treeKey));
    await decryptFile(encrypted, plain, manifest.treeEncryption ?? manifest.encryption, encryption);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("save commit protocol", () => {
  it("writes data under generation-scoped keys and garbage-collects the superseded object", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "gen-keys", size: "16M", storage, encryption });
    const created = await readManifest(storage, "gen-keys");
    expect(created.treeKey).toMatch(/^contexts\/gen-keys\/tree\/00000001-[0-9a-f]{8}\.tree\.tar\.zst\.enc$/);

    await runWithContext({
      id: "gen-keys",
      storage,
      encryption,
      runtime: new FakeRuntime(),
    }, async () => undefined);

    const saved = await readManifest(storage, "gen-keys");
    expect(saved.generation).toBe(2);
    expect(saved.treeKey).toMatch(/^contexts\/gen-keys\/tree\/00000002-[0-9a-f]{8}\./);
    await expect(storage.headObject(created.treeKey)).resolves.toBeNull();
    await expectDecryptable(storage, "gen-keys");
  });

  it("leaves the previous generation fully intact when the manifest write fails", async () => {
    class ManifestFailsOnce extends MemoryStorage {
      failed = false;
      async putObject(key: string, body: Buffer | Uint8Array | string, options?: PutObjectOptions): Promise<void> {
        if (!this.failed && key.endsWith("manifest.json") && (body as string).includes('"generation": 2')) {
          this.failed = true;
          throw new Error("network dropped before the manifest landed");
        }
        await super.putObject(key, body, options);
      }
    }
    const storage = new ManifestFailsOnce();
    await createContext({ id: "torn", size: "16M", storage, encryption });
    const before = await readManifest(storage, "torn");

    await expect(runWithContext({
      id: "torn",
      storage,
      encryption,
      runtime: new FakeRuntime(),
      saveOnError: false,
    }, async () => undefined)).rejects.toThrow(/network dropped/);

    // The old manifest must still point at ciphertext its metadata can decrypt,
    // and the aborted save's data object must have been rolled back.
    const after = await readManifest(storage, "torn");
    expect(after.generation).toBe(1);
    expect(after.treeKey).toBe(before.treeKey);
    await expectDecryptable(storage, "torn");
    await expect(storage.headObject(after.treeKey)).resolves.not.toBeNull();
  });

  it("aborts the save with ContextLockError when the manifest changed under it", async () => {
    class StaleEtag extends MemoryStorage {
      async getObjectWithMetadata(key: string): Promise<{ body: Buffer; metadata: ObjectMetadata }> {
        const result = await super.getObjectWithMetadata(key);
        if (key.endsWith("manifest.json")) {
          return { ...result, metadata: { ...result.metadata, etag: "stale-etag" } };
        }
        return result;
      }
    }
    const storage = new StaleEtag();
    await createContext({ id: "cas", size: "16M", storage, encryption });
    await expect(saveContext({
      id: "cas",
      storage,
      encryption,
      runtime: new FakeRuntime(),
      mode: "directoryBundle",
    })).rejects.toThrow(ContextLockError);
    // The conflicting writer's data is untouched and still decryptable.
    await expectDecryptable(storage, "cas");
  });

  it("loses the create race cleanly when another writer created the context first", async () => {
    class BlindHead extends MemoryStorage {
      async headObject(key: string): Promise<ObjectMetadata | null> {
        if (key.endsWith("manifest.json")) {
          return null;
        }
        return super.headObject(key);
      }
    }
    const storage = new BlindHead();
    await createContext({ id: "race", size: "16M", storage, encryption });
    await expect(createContext({ id: "race", size: "16M", storage, encryption }))
      .rejects.toThrow(ContextSDKError);
    await expect(createContext({ id: "race", size: "16M", storage, encryption }))
      .rejects.toThrow(/already exists/);
    await expectDecryptable(storage, "race");
  });

  it("does not save at all when saveOnError is false and the callback throws", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "no-save", size: "16M", storage, encryption });
    await expect(runWithContext({
      id: "no-save",
      storage,
      encryption,
      runtime: new FakeRuntime(),
      saveOnError: false,
    }, async () => {
      throw new Error("callback failed");
    })).rejects.toThrow(/callback failed/);
    const manifest = await readManifest(storage, "no-save");
    expect(manifest.generation).toBe(1);
    expect(manifest.versions ?? []).toHaveLength(0);
  });

  it("prunes historical generation and checkpoint objects on force-recreate", async () => {
    const storage = new MemoryStorage();
    await createContext({ id: "recreate", size: "16M", storage, encryption });
    // Build some history: a save (new generation) and a stray checkpoint object.
    await runWithContext({ id: "recreate", storage, encryption, runtime: new FakeRuntime() }, async () => undefined);
    await storage.putObject("contexts/recreate/checkpoints/00000001.tree.tar.zst.enc", "old checkpoint");
    const before = await storage.listObjects("contexts/recreate/");
    expect(before.length).toBeGreaterThan(2);

    await createContext({ id: "recreate", size: "16M", storage, encryption, force: true });

    const treeObjects = await storage.listObjects("contexts/recreate/tree/");
    const checkpointObjects = await storage.listObjects("contexts/recreate/checkpoints/");
    const manifest = await readManifest(storage, "recreate");
    // Only the fresh generation-1 bundle survives; old generations and checkpoints are gone.
    expect(treeObjects).toEqual([manifest.treeKey]);
    expect(checkpointObjects).toEqual([]);
    await expectDecryptable(storage, "recreate");
  });

  it("rejects context ids that could escape their storage prefix", async () => {
    const storage = new MemoryStorage();
    await expect(createContext({ id: "../evil", size: "16M", storage, encryption })).rejects.toThrow(/invalid context id/);
    await expect(createContext({ id: "a/b", size: "16M", storage, encryption })).rejects.toThrow(/invalid context id/);
    await expect(createContext({ id: "..", size: "16M", storage, encryption })).rejects.toThrow(/invalid context id/);
  });
});
