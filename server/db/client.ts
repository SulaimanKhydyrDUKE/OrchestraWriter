// Postgres connection pool.
// Export the pool and a `query()` helper that the rest of the server imports.
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { Pool, type QueryResultRow } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { env } from "../config/env.js";
import { awsConfig } from "../config/aws.js";

// IAM authentication (Aurora). The Signer is the code equivalent of
// `aws rds generate-db-auth-token`: it signs a short-lived (15 min) token
// using the AWS credentials. It makes no network call and never talks to
// the database itself. Skipped entirely when DB_PASSWORD is set (local Postgres).
const signer = env.db.password
  ? undefined
  : new Signer({
      hostname: env.db.host,
      port: env.db.port,
      username: env.db.user,
      region: awsConfig.region,
    });

// TLS. The server certificate is verified against Node's built-in public roots
// (the Aurora cluster chains to Amazon Root CA 1, a public CA).
// If DB_SSL_CA_PATH is set, that bundle is ADDED to the roots rather than
// replacing them, so clusters issued by the RDS private CA also verify.
// DB_SSL_VERIFY=false turns verification off (psql's sslmode=require); debugging only.
// DB_SSL=false turns TLS off; only for a local Postgres.
const ssl = env.db.ssl
  ? {
      rejectUnauthorized: env.db.sslVerify,
      ca: env.db.sslCaPath
        ? [...tls.rootCertificates, readFileSync(env.db.sslCaPath, "utf8")]
        : undefined,
    }
  : false;

export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.name,
  user: env.db.user,
  // pg calls a function password every time it opens a NEW connection, so each
  // one gets a fresh IAM token. Connections already open are unaffected by expiry.
  password: env.db.password ?? (() => signer!.getAuthToken()),
  ssl,
  // app tables first, then auth (see sql/migrations/20261022_01_auth_app_schemas.sql).
  options: "-c search_path=app,auth,public",
  max: 10,
  idleTimeoutMillis: 30_000,
  // Aurora Serverless v2 is configured with min 0 ACU and pauses after 5 idle
  // minutes. Resuming takes ~15s, and the connection that triggers it must wait
  // that long or the first request after idle fails. Set min ACU to 0.5 to
  // remove the pause (and this delay) at the cost of an always-on instance.
  connectionTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});

// Errors that mean "the connection died", as opposed to "your SQL is wrong".
// Seen while Aurora resumes from auto-pause: the TCP connect succeeds, then the
// server drops it, or the handshake exceeds the timeout.
const CONNECTION_ERROR = /terminated|timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i;

/**
 * Run a parameterised query and return the rows. Use $1, $2... for params.
 * Retries once if the connection itself failed, which covers the first query
 * after the cluster has auto-paused. Queries with side effects are safe to
 * retry here because a connection failure means the statement never ran.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await pool.query<T>(text, params);
      return result.rows;
    } catch (err) {
      const connectionFailed = err instanceof Error && CONNECTION_ERROR.test(err.message);
      if (!connectionFailed || attempt >= 3) throw err;
      console.warn(`database connection failed (${(err as Error).message}); retrying (${attempt}/2)`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

/** Drain the pool. Call on shutdown and at the end of one-off scripts. */
export async function closePool(): Promise<void> {
  await pool.end();
}
