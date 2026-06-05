import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptFile, encryptFile } from "../src/crypto.js";

describe("encryption", () => {
  it("round trips a file with passphrase-derived AES-256-GCM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contextsdk-test-"));
    try {
      const input = join(dir, "input");
      const encrypted = join(dir, "encrypted");
      const output = join(dir, "output");
      await writeFile(input, "agent memory checkpoint\n");
      const metadata = await encryptFile(input, encrypted, { passphrase: "test-passphrase" });
      await decryptFile(encrypted, output, metadata, { passphrase: "test-passphrase" });
      await expect(readFile(output, "utf8")).resolves.toBe("agent memory checkpoint\n");
      expect(metadata.algorithm).toBe("aes-256-gcm");
      expect(metadata.keyDerivation).toBe("scrypt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
