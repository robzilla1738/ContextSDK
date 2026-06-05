import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { ContextSDKError } from "./errors.js";
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
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return readableToBuffer(response.Body);
    } catch (error) {
      if (isMissingObject(error)) {
        throw new ContextSDKError(`object not found: ${key}`);
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
    await this.client.send(new PutObjectCommand(commandInput));
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return { size: response.ContentLength, updatedAt: response.LastModified };
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }
      throw error;
    }
  }

  private key(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
}

function isMissingObject(error: unknown): boolean {
  return error instanceof NoSuchKey || error instanceof NotFound || (typeof error === "object" && error !== null && ["NoSuchKey", "NotFound", "404"].includes(String((error as { name?: string }).name)));
}
