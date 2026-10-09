import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { config } from "./config.js";

/** Applies db/migrations/*.sql in order, each once, inside a transaction. */
export async function migrate(databaseUrl = config.databaseUrl, dir = config.migrationsDir) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Serialise concurrent migrators (e.g. api and a test run starting together).
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        console.log(`migrate: applied ${f}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("migrate: up to date");
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((err) => {
    console.error("migrate failed", err);
    process.exit(1);
  });
}
