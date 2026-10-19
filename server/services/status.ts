// Backend self-checks surfaced by GET /api/status and shown on the page, so anyone
// can see at a glance that the database, the bucket and auth are really wired up.
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";
import { query } from "../db/client.js";
import { s3 } from "../storage/s3Client.js";

export type Check = { ok: boolean; latencyMs: number; detail: string };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One round trip to Postgres plus a count that proves the seed ran. */
export async function checkDatabase(): Promise<Check & { instruments?: number }> {
  const started = Date.now();
  try {
    const [row] = await query<{ instruments: string; version: string }>(
      "SELECT (SELECT count(*) FROM instruments) AS instruments, version() AS version",
    );
    const instruments = Number(row?.instruments ?? 0);
    const version = row?.version.split(" on ")[0] ?? "PostgreSQL";
    return {
      ok: true,
      latencyMs: Date.now() - started,
      instruments,
      detail: `${version}, ${instruments} instruments seeded, host ${env.db.host.split(".")[0]}`,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, detail: message(err) };
  }
}

/** HeadBucket proves credentials, region and bucket policy all line up. */
export async function checkStorage(): Promise<Check & { bucket?: string }> {
  const started = Date.now();
  if (!env.s3.audioBucket) {
    return { ok: false, latencyMs: 0, detail: "S3_AUDIO_BUCKET is not set" };
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.s3.audioBucket }));
    return {
      ok: true,
      latencyMs: Date.now() - started,
      bucket: env.s3.audioBucket,
      detail: `bucket ${env.s3.audioBucket} reachable in ${env.aws.region}`,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, bucket: env.s3.audioBucket, detail: message(err) };
  }
}
