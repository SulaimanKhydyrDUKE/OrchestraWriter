// S3 client instance built from config/aws.ts.
// Credentials come from the SDK's default chain: env vars, ~/.aws, or the
// App Runner instance role in production. Nothing is configured here.
import { S3Client } from "@aws-sdk/client-s3";
import { awsConfig } from "../config/aws.js";

export const s3 = new S3Client({ region: awsConfig.region });
