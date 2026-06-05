import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { EncryptionConfig, EncryptionMetadata, ScryptParams } from "./types.js";
import { ContextSDKError } from "./errors.js";

const keyLength = 32;
const nonceLength = 12;
const authTagLength = 16;
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP-aligned default for new encryptions: N=2^17, r=8, p=1 (~128 MiB). */
export const defaultScryptParams: ScryptParams = { cost: 131072, blockSize: 8, parallelization: 1 };

/** Parameters used by bundles written before scrypt params were recorded in metadata (Node.js defaults). */
export const legacyScryptParams: ScryptParams = { cost: 16384, blockSize: 8, parallelization: 1 };

export async function encryptFile(inputPath: string, outputPath: string, config: EncryptionConfig): Promise<EncryptionMetadata> {
  const useRawKey = Boolean(config.rawKeyHex);
  const salt = useRawKey ? undefined : randomBytes(16);
  const nonce = randomBytes(nonceLength);
  const scryptParams = useRawKey ? undefined : resolveScryptParams(config.scrypt);
  const key = await deriveKey(config, useRawKey ? "raw" : "scrypt", salt, scryptParams);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength });
  // createCipheriv copies the key into the native handle; scrub the JS copy immediately.
  key.fill(0);
  await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath, { mode: 0o600 }));
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyDerivation: useRawKey ? "raw" : "scrypt",
    salt: salt?.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    scrypt: scryptParams,
  };
}

export async function decryptFile(inputPath: string, outputPath: string, metadata: EncryptionMetadata, config: EncryptionConfig): Promise<void> {
  if (metadata.version !== 1) {
    throw new ContextSDKError(`unsupported encryption metadata version: ${String(metadata.version)}`);
  }
  if (metadata.algorithm !== "aes-256-gcm") {
    throw new ContextSDKError(`unsupported encryption algorithm: ${metadata.algorithm}`);
  }
  const salt = metadata.salt ? Buffer.from(metadata.salt, "base64") : undefined;
  const nonce = Buffer.from(metadata.nonce, "base64");
  const authTag = Buffer.from(metadata.authTag, "base64");
  // Metadata travels outside the ciphertext, so its fields are attacker-influenceable.
  // GCM happily verifies against a truncated tag or an unusual nonce length, which would
  // weaken integrity; pin both to the exact values the encrypt side produces.
  if (nonce.byteLength !== nonceLength) {
    throw new ContextSDKError(`encryption metadata nonce must be ${nonceLength} bytes, got ${nonce.byteLength}`);
  }
  if (authTag.byteLength !== authTagLength) {
    throw new ContextSDKError(`encryption metadata authTag must be ${authTagLength} bytes, got ${authTag.byteLength}`);
  }
  const scryptParams = metadata.keyDerivation === "scrypt" ? metadata.scrypt ?? legacyScryptParams : undefined;
  const key = await deriveKey(config, metadata.keyDerivation, salt, scryptParams);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength });
  key.fill(0);
  decipher.setAuthTag(authTag);
  try {
    await pipeline(createReadStream(inputPath), decipher, createWriteStream(outputPath, { mode: 0o600 }));
  } catch (error) {
    // GCM only verifies the tag at the end of the stream, so a tampered bundle has already
    // streamed unauthenticated plaintext into outputPath. Never leave that behind.
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveScryptParams(overrides?: Partial<ScryptParams>): ScryptParams {
  const params = {
    cost: overrides?.cost ?? defaultScryptParams.cost,
    blockSize: overrides?.blockSize ?? defaultScryptParams.blockSize,
    parallelization: overrides?.parallelization ?? defaultScryptParams.parallelization,
  };
  if (!Number.isInteger(params.cost) || params.cost < 2 || (params.cost & (params.cost - 1)) !== 0) {
    throw new ContextSDKError("scrypt cost must be a power of two greater than one");
  }
  if (!Number.isInteger(params.blockSize) || params.blockSize < 1) {
    throw new ContextSDKError("scrypt blockSize must be a positive integer");
  }
  if (!Number.isInteger(params.parallelization) || params.parallelization < 1) {
    throw new ContextSDKError("scrypt parallelization must be a positive integer");
  }
  return params;
}

async function deriveKey(
  config: EncryptionConfig,
  derivation: "scrypt" | "raw",
  salt: Buffer | undefined,
  scryptParams: ScryptParams | undefined,
): Promise<Buffer> {
  if (derivation === "raw") {
    if (!config.rawKeyHex) {
      throw new ContextSDKError("this context was encrypted with a raw key; rawKeyHex is required to decrypt it");
    }
    const raw = Buffer.from(config.rawKeyHex, "hex");
    if (raw.byteLength !== keyLength) {
      throw new ContextSDKError("raw encryption key must be exactly 32 bytes encoded as hex");
    }
    return raw;
  }
  if (!config.passphrase) {
    throw new ContextSDKError("encryption passphrase is required");
  }
  if (!salt) {
    throw new ContextSDKError("scrypt encryption metadata is missing salt");
  }
  const params = scryptParams ?? defaultScryptParams;
  return scryptAsync(config.passphrase, salt, keyLength, {
    N: params.cost,
    r: params.blockSize,
    p: params.parallelization,
    // scrypt needs 128 * N * r bytes; double it for headroom so Node does not reject the derivation.
    maxmem: 256 * params.cost * params.blockSize,
  });
}
