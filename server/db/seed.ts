// Seed runner: `npm run db:seed`. Executes sql/seeds/*.sql in filename order.
// Seeds are NOT tracked like schema files; write them to be re-runnable
// (INSERT ... ON CONFLICT DO NOTHING) because this runs on every deploy.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, closePool } from "./client.js";

const seedsDir = fileURLToPath(new URL("./sql/seeds/", import.meta.url));

async function main(): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(seedsDir)).filter((n) => n.endsWith(".sql")).sort();
  } catch {
    // no seeds folder
  }
  for (const name of names) {
    const sql = await readFile(path.join(seedsDir, name), "utf8");
    await pool.query(sql);
    console.log(`seeded   seeds/${name}`);
  }
  console.log(names.length === 0 ? "No seed files." : `Ran ${names.length} seed file(s).`);
}

try {
  await main();
} finally {
  await closePool();
}
