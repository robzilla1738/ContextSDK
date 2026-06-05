import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { ObjectNotFoundError, StorageConditionError } from "./errors.js";
import { readableToBuffer, type ObjectMetadata, type PutObjectOptions, type StorageAdapter } from "./storage.js";

export interface S3StorageOptions {
  bucket: string;
  prefix?: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

export class S3Storage implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/\/+$/g, "") : "";
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
  }

  async getObject(key: string): Promise<Buffer> {
    return (await this.getObjectWithMetadata(key)).body;
  }

  async getObjectWithMetadata(key: string): Promise<{ body: Buffer; metadata: ObjectMetadata }> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return {
        body: await readableToBuffer(response.Body),
        metadata: { size: response.ContentLength, updatedAt: response.LastModified, etag: response.ETag },
      };
    } catch (error) {
      if (isMissingObject(error)) {
        throw new ObjectNotFoundError(key);
      }
      throw error;
    }
  }

  async putObject(key: string, body: Buffer | Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    const commandInput: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: this.key(key),
      Body: body,
    };
    if (options.ifNoneMatch) {
      commandInput.IfNoneMatch = options.ifNoneMatch;
    }
    if (options.ifMatch) {
      commandInput.IfMatch = options.ifMatch;
    }
    try {
      await this.client.send(new PutObjectCommand(commandInput));
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new StorageConditionError(
          options.ifNoneMatch
            ? `object already exists: ${key}`
            : `precondition failed for object: ${key}`,
        );
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return { size: response.ContentLength, updatedAt: response.LastModified, etag: response.ETag };
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }
      throw error;
    }
  }

  async listObjects(prefix: string): Promise<string[]> {
    const fullPrefix = this.key(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix,
        ContinuationToken: continuationToken,
      }));
      for (const object of response.Contents ?? []) {
        if (object.Key) {
          // Strip the storage prefix so callers see context-relative keys.
          keys.push(this.prefix ? object.Key.slice(this.prefix.length + 1) : object.Key);
        }
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  private key(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
}

function isMissingObject(error: unknown): boolean {
  return error instanceof NoSuchKey || error instanceof NotFound || (typeof error === "object" && error !== null && ["NoSuchKey", "NotFound", "404"].includes(String((error as { name?: string }).name)));
}

function isConditionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = String((error as { name?: string }).name);
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || status === 412 || status === 409;
}
