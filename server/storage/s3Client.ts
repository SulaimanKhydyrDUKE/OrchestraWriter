// S3 clients built from config/aws.ts and config/env.ts.
// Credentials come from the SDK's default chain: env vars, ~/.aws, or the
// App Runner instance role in production. Nothing is configured here.
//
// Two clients exist because a presigned URL is bound to the hostname inside it.
// In docker compose the server reaches S3Mock as http://s3:9090 but the browser
// reaches it as http://localhost:9090, so URLs for the browser are signed with the
// public endpoint. Against real S3 both endpoints are empty and the two are the same.
import { S3Client } from "@aws-sdk/client-s3";
import { awsConfig } from "../config/aws.js";
import { env } from "../config/env.js";

function makeClient(endpoint: string | undefined): S3Client {
  return new S3Client({
    region: awsConfig.region,
    // S3Mock and friends need path-style URLs (host/bucket/key, not bucket.host/key).
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

/** For calls the server makes itself: HeadBucket, DeleteObject. */
export const s3 = makeClient(env.s3.endpoint);

/** For URLs handed to the browser: presigned PUT and GET. */
export const s3Presign =
  env.s3.publicEndpoint === env.s3.endpoint ? s3 : makeClient(env.s3.publicEndpoint);
