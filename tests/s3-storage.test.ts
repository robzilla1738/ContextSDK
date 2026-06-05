import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { ObjectNotFoundError, StorageConditionError } from "../src/errors.js";
import { S3Storage } from "../src/s3-storage.js";

type SentCommand = { constructor: { name: string }; input: Record<string, unknown> };

function fakeClient(handler: (command: SentCommand) => unknown): S3Client {
  return { send: async (command: SentCommand) => handler(command) } as unknown as S3Client;
}

function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

describe("s3 storage", () => {
  it("maps 412 precondition failures on conditional create to StorageConditionError", async () => {
    const storage = new S3Storage({
      bucket: "bucket",
      client: fakeClient(() => {
        throw awsError("PreconditionFailed", 412);
      }),
    });
    await expect(storage.putObject("contexts/x/lock.json", "{}", { ifNoneMatch: "*" }))
      .rejects.toBeInstanceOf(StorageConditionError);
    await expect(storage.putObject("contexts/x/lock.json", "{}", { ifMatch: "\"etag\"" }))
      .rejects.toBeInstanceOf(StorageConditionError);
  });

  it("maps concurrent conditional-write conflicts to StorageConditionError", async () => {
    const storage = new S3Storage({
      bucket: "bucket",
      client: fakeClient(() => {
        throw awsError("ConditionalRequestConflict", 409);
      }),
    });
    await expect(storage.putObject("key", "data", { ifNoneMatch: "*" }))
      .rejects.toBeInstanceOf(StorageConditionError);
  });

  it("passes conditional headers through to S3", async () => {
    const sent: SentCommand[] = [];
    const storage = new S3Storage({
      bucket: "bucket",
      prefix: "team",
      client: fakeClient(command => {
        sent.push(command);
        return {};
      }),
    });
    await storage.putObject("key", "data", { ifNoneMatch: "*" });
    await storage.putObject("key", "data", { ifMatch: "\"abc\"" });
    expect(sent[0].input).toMatchObject({ Bucket: "bucket", Key: "team/key", IfNoneMatch: "*" });
    expect(sent[1].input).toMatchObject({ Bucket: "bucket", Key: "team/key", IfMatch: "\"abc\"" });
  });

  it("throws a typed error for missing objects", async () => {
    const storage = new S3Storage({
      bucket: "bucket",
      client: fakeClient(() => {
        throw awsError("NoSuchKey", 404);
      }),
    });
    await expect(storage.getObject("missing")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("exposes etags from head and get responses", async () => {
    const storage = new S3Storage({
      bucket: "bucket",
      client: fakeClient(command => {
        if (command.constructor.name === "HeadObjectCommand") {
          return { ContentLength: 4, LastModified: new Date(0), ETag: "\"etag-1\"" };
        }
        return { Body: Buffer.from("data"), ContentLength: 4, LastModified: new Date(0), ETag: "\"etag-1\"" };
      }),
    });
    await expect(storage.headObject("key")).resolves.toMatchObject({ etag: "\"etag-1\"" });
    await expect(storage.getObjectWithMetadata("key")).resolves.toMatchObject({
      body: Buffer.from("data"),
      metadata: { etag: "\"etag-1\"" },
    });
  });
});
