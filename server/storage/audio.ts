// Audio file storage on S3: presigned upload/download URLs and deletion.
// The server never proxies bytes. The browser PUTs straight to S3 with a URL
// we sign, and GETs the same way. Object keys are recorded in the DB.
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { s3, s3Presign } from "./s3Client.js";

const URL_TTL_SECONDS = 15 * 60;

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("S3_AUDIO_BUCKET is not set");
    this.name = "StorageNotConfiguredError";
  }
}

function bucket(): string {
  if (!env.s3.audioBucket) throw new StorageNotConfiguredError();
  return env.s3.audioBucket;
}

/**
 * Key for a new upload: users/<userId>/<uuid>-<safe-filename>.
 * Keys are namespaced per user, so a key alone tells us who owns it.
 */
export function newAudioKey(userId: number, filename: string): string {
  const safe =
    filename
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "audio";
  return `users/${userId}/${randomUUID()}-${safe}`;
}

export function keyBelongsTo(key: string, userId: number): boolean {
  return key.startsWith(`users/${userId}/`);
}

/** URL the browser can PUT the file to. It must send the same Content-Type. */
export function presignUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    s3Presign,
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS },
  );
}

/** URL the browser can GET (or stream in an <audio> element). */
export function presignDownload(key: string): Promise<string> {
  return getSignedUrl(s3Presign, new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: URL_TTL_SECONDS,
  });
}

export async function deleteAudio(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
