import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptFile, encryptFile, legacyScryptParams } from "../src/crypto.js";
import type { EncryptionMetadata } from "../src/types.js";

// Small-but-valid parameters keep KDF-heavy tests fast; strength is not under test there.
const fastScrypt = { cost: 1024, blockSize: 8, parallelization: 1 };

describe("encryption", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "contextsdk-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round trips a file with passphrase-derived AES-256-GCM", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "agent memory checkpoint\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test-passphrase", scrypt: fastScrypt });
    await decryptFile(encrypted, output, metadata, { passphrase: "test-passphrase" });
    await expect(readFile(output, "utf8")).resolves.toBe("agent memory checkpoint\n");
    expect(metadata.algorithm).toBe("aes-256-gcm");
    expect(metadata.keyDerivation).toBe("scrypt");
    expect(metadata.scrypt).toEqual(fastScrypt);
  });

  it("round trips a file with a raw key", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "raw key data\n");
    const rawKeyHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const metadata = await encryptFile(input, encrypted, { rawKeyHex });
    expect(metadata.keyDerivation).toBe("raw");
    expect(metadata.salt).toBeUndefined();
    expect(metadata.scrypt).toBeUndefined();
    await decryptFile(encrypted, output, metadata, { rawKeyHex });
    await expect(readFile(output, "utf8")).resolves.toBe("raw key data\n");
  });

  it("rejects decryption with a wrong passphrase", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "secret\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "correct", scrypt: fastScrypt });
    await expect(decryptFile(encrypted, output, metadata, { passphrase: "wrong" })).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "integrity matters\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: fastScrypt });
    const ciphertext = await readFile(encrypted);
    ciphertext[0] ^= 0xff;
    await writeFile(encrypted, ciphertext);
    await expect(decryptFile(encrypted, output, metadata, { passphrase: "test" })).rejects.toThrow();
  });

  it("rejects a tampered auth tag", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "auth tag check\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: fastScrypt });
    const tag = Buffer.from(metadata.authTag, "base64");
    tag[0] ^= 0xff;
    const tampered: EncryptionMetadata = { ...metadata, authTag: tag.toString("base64") };
    await expect(decryptFile(encrypted, output, tampered, { passphrase: "test" })).rejects.toThrow();
  });

  it("uses a fresh nonce and salt for every encryption", async () => {
    const input = join(dir, "input");
    await writeFile(input, "same plaintext\n");
    const first = await encryptFile(input, join(dir, "enc-1"), { passphrase: "test", scrypt: fastScrypt });
    const second = await encryptFile(input, join(dir, "enc-2"), { passphrase: "test", scrypt: fastScrypt });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.salt).not.toBe(second.salt);
    const bodyOne = await readFile(join(dir, "enc-1"));
    const bodyTwo = await readFile(join(dir, "enc-2"));
    expect(bodyOne.equals(bodyTwo)).toBe(false);
  });

  it("decrypts legacy metadata without recorded scrypt parameters", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "legacy bundle\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: legacyScryptParams });
    // Legacy bundles predate the scrypt field; decryption must fall back to the legacy parameters.
    const legacyMetadata: EncryptionMetadata = { ...metadata };
    delete legacyMetadata.scrypt;
    await decryptFile(encrypted, output, legacyMetadata, { passphrase: "test" });
    await expect(readFile(output, "utf8")).resolves.toBe("legacy bundle\n");
  });

  it("requires the matching key material for the recorded derivation", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "derivation check\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: fastScrypt });
    await expect(decryptFile(encrypted, output, metadata, {
      rawKeyHex: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    })).rejects.toThrow(/passphrase is required/);
  });

  it("rejects invalid scrypt parameters", async () => {
    const input = join(dir, "input");
    await writeFile(input, "params\n");
    await expect(encryptFile(input, join(dir, "enc"), { passphrase: "test", scrypt: { cost: 1000 } }))
      .rejects.toThrow(/power of two/);
  });

  it("rejects a truncated auth tag instead of authenticating against it", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "tag length matters\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: fastScrypt });
    // GCM verifies against whatever tag length setAuthTag receives; a manifest
    // rewrite must not be able to downgrade the effective tag strength.
    const truncated: EncryptionMetadata = {
      ...metadata,
      authTag: Buffer.from(metadata.authTag, "base64").subarray(0, 8).toString("base64"),
    };
    await expect(decryptFile(encrypted, output, truncated, { passphrase: "test" })).rejects.toThrow(/authTag must be 16 bytes/);
  });

  it("rejects a nonce of unexpected length", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    await writeFile(input, "nonce length matters\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: fastScrypt });
    const oversized: EncryptionMetadata = { ...metadata, nonce: Buffer.alloc(16, 1).toString("base64") };
    await expect(decryptFile(encrypted, join(dir, "out"), oversized, { passphrase: "test" })).rejects.toThrow(/nonce must be 12 bytes/);
  });

  it("removes the partially written plaintext when authentication fails", async () => {
    const input = join(dir, "input");
    const encrypted = join(dir, "encrypted");
    const output = join(dir, "output");
    await writeFile(input, "do not leave unverified plaintext behind\n");
    const metadata = await encryptFile(input, encrypted, { passphrase: "test", scrypt: fastScrypt });
    const ciphertext = await readFile(encrypted);
    ciphertext[ciphertext.length - 1] ^= 0xff;
    await writeFile(encrypted, ciphertext);
    await expect(decryptFile(encrypted, output, metadata, { passphrase: "test" })).rejects.toThrow();
    await expect(readFile(output)).rejects.toThrow(/ENOENT/);
  });
});
