// Plain S3 object reads and writes for the pipeline (the API never moves bytes itself).
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { s3 } from "./s3Client.js";
import { StorageNotConfiguredError } from "./audio.js";

function bucket(): string {
  if (!env.s3.audioBucket) throw new StorageNotConfiguredError();
  return env.s3.audioBucket;
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!res.Body) throw new Error(`S3 object ${key} has no body`);
  return res.Body.transformToByteArray();
}

export async function putObjectBytes(key: string, body: Uint8Array | string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
}
