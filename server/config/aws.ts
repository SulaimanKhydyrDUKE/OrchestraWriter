// Shared AWS SDK settings used by both the RDS signer and the S3 client.
// Credentials are NOT set here: the SDK resolves them automatically from
// env vars, ~/.aws, or an attached IAM role, in that order.
import { env } from "./env.js";

export const awsConfig = {
  region: env.aws.region,
} as const;
