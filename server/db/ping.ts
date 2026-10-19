// Connection smoke test: `npm run db:ping`.
// Proves IAM token auth, TLS, and network access all work before writing anything.
import { env } from "../config/env.js";
import { query, closePool } from "./client.js";

type PingRow = { now: Date; version: string; db_user: string; db_name: string };

try {
  const [row] = await query<PingRow>(
    "select now() as now, version() as version, current_user as db_user, current_database() as db_name",
  );
  console.log(`Connected to ${env.db.host}`);
  console.log(`  as user:     ${row.db_user}`);
  console.log(`  database:    ${row.db_name}`);
  console.log(`  server time: ${row.now.toISOString()}`);
  console.log(`  version:     ${row.version}`);
} finally {
  await closePool();
}
