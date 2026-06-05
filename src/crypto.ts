import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { EncryptionConfig, EncryptionMetadata } from "./types.js";
import { ContextSDKError } from "./errors.js";

const keyLength = 32;

export async function encryptFile(inputPath: string, outputPath: string, config: EncryptionConfig): Promise<EncryptionMetadata> {
  const salt = config.rawKeyHex ? undefined : randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(config, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath, { mode: 0o600 }));
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyDerivation: config.rawKeyHex ? "raw" : "scrypt",
    salt: salt?.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export async function decryptFile(inputPath: string, outputPath: string, metadata: EncryptionMetadata, config: EncryptionConfig): Promise<void> {
  if (metadata.algorithm !== "aes-256-gcm") {
    throw new ContextSDKError(`unsupported encryption algorithm: ${metadata.algorithm}`);
  }
  const salt = metadata.salt ? Buffer.from(metadata.salt, "base64") : undefined;
  const key = deriveKey(config, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));
  await pipeline(createReadStream(inputPath), decipher, createWriteStream(outputPath, { mode: 0o600 }));
}

function deriveKey(config: EncryptionConfig, salt?: Buffer): Buffer {
  if (config.rawKeyHex) {
    const raw = Buffer.from(config.rawKeyHex, "hex");
    if (raw.byteLength !== keyLength) {
      throw new ContextSDKError("raw encryption key must be exactly 32 bytes encoded as hex");
    }
    return raw;
  }
  if (!config.passphrase) {
    throw new ContextSDKError("encryption passphrase or rawKeyHex is required");
  }
  if (!salt) {
    throw new ContextSDKError("scrypt encryption metadata is missing salt");
  }
  return scryptSync(config.passphrase, salt, keyLength);
}
