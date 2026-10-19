// Schema runner: `npm run db:migrate`.
// Applies sql/schema/*.sql, then sql/migrations/*.sql, in filename order, each
// exactly once. Applied filenames are recorded in schema_migrations, so the
// command is safe to re-run. The production container runs it on every start.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./client.js";

// Resolved relative to this file, so it works from server/ (tsx) and dist/ (node).
const sqlRoot = fileURLToPath(new URL("./sql/", import.meta.url));
const folders = ["schema", "migrations"] as const;

async function listSqlFiles(folder: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(sqlRoot, folder));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((n) => `${folder}/${n}`);
}

/**
 * Aurora Serverless v2 with min capacity 0 auto-pauses when idle. The first
 * connection wakes it and can fail or hang for ~15s, so retry before giving up.
 */
async function waitForDatabase(): Promise<void> {
  const attempts = 8;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`database not ready (${(err as Error).message}); retry ${i}/${attempts - 1} in 10s`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

async function main(): Promise<void> {
  await waitForDatabase();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
      (r) => r.filename,
    ),
  );

  const files = (await Promise.all(folders.map(listSqlFiles))).flat();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(sqlRoot, file), "utf8");

    // One transaction per file: either every statement in it lands, or none do.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied  ${file}`);
      count++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`${file}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  console.log(count === 0 ? "Schema already up to date." : `Applied ${count} file(s).`);
}

try {
  await main();
} finally {
  await closePool();
}
