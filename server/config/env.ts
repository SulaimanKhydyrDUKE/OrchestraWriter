// Reads and validates environment variables (see .env.example).
// Everything else imports `env` from here; nothing else touches process.env.
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const nodeEnv = optional("NODE_ENV", "development");
const isProduction = nodeEnv === "production";
const port = Number(optional("PORT", "3000"));

export const env = {
  nodeEnv,
  isProduction,
  port,

  aws: {
    region: required("AWS_REGION"),
  },

  // Postgres. Two modes:
  //   - Aurora (default): no DB_PASSWORD; an IAM token is generated per connection.
  //   - Local Docker Postgres: set DB_PASSWORD and DB_SSL=false.
  db: {
    host: required("DB_HOST"),
    port: Number(optional("DB_PORT", "5432")),
    name: required("DB_NAME"),
    user: required("DB_USER"),
    password: process.env.DB_PASSWORD || undefined,
    // DB_SSL=false disables TLS entirely (a local Postgres has none).
    ssl: optional("DB_SSL", "true") !== "false",
    // Verify the server certificate (default true). Only set false while debugging.
    sslVerify: optional("DB_SSL_VERIFY", "true") !== "false",
    // Optional extra CA bundle, added to Node's built-in roots. Needed only for
    // clusters whose certificate is issued by the RDS private CA.
    sslCaPath: process.env.DB_SSL_CA_PATH || undefined,
  },

  s3: {
    // Optional until the bucket exists; file routes return 503 without it.
    audioBucket: process.env.S3_AUDIO_BUCKET || undefined,
    // Local S3 stand-in (S3Mock via docker compose). S3_ENDPOINT is what the server
    // calls; S3_PUBLIC_ENDPOINT is the same service as the browser reaches it, used
    // only when signing URLs the browser will open. Both empty = real AWS S3.
    endpoint: process.env.S3_ENDPOINT || undefined,
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
  },

  // Extra browser origins allowed to call /api/* with cookies, e.g. a frontend dev
  // server on http://localhost:5173. Comma-separated. Empty = same-origin only.
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // Transcription pipeline. "stepfunctions" in production (STATE_MACHINE_ARN set),
  // "inline" locally: the same step code runs inside the API process, no AWS needed.
  pipeline: {
    stateMachineArn: process.env.STATE_MACHINE_ARN || undefined,
    mode: (process.env.PIPELINE_MODE ||
      (process.env.STATE_MACHINE_ARN ? "stepfunctions" : "inline")) as "stepfunctions" | "inline",
  },

  auth: {
    // Signs session cookies. Required in production; a fixed dev value otherwise.
    secret: isProduction
      ? required("BETTER_AUTH_SECRET")
      : optional("BETTER_AUTH_SECRET", "dev-only-secret-not-for-production"),
    // Public origin of the site. Better Auth builds OAuth callback URLs from it,
    // so it must match what the browser sees (including https:// in production).
    url: optional("BETTER_AUTH_URL", `http://localhost:${port}`),
    // Google sign-in is enabled only when both values are present.
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
    },
  },
} as const;
