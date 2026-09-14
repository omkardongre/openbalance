import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadIndexerDatabaseConfig } from "./config.js";

const migrations = [
  "001_finalized_indexer",
  "002_provisional_indexer",
  "003_projection_rebuilds",
] as const;

async function migrate() {
  const config = loadIndexerDatabaseConfig(process.env);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    application_name: "openbalance-indexer-migration",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(712034815)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS indexer_schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    for (const migrationName of migrations) {
      const sql = await readFile(
        new URL(`../migrations/${migrationName}.sql`, import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM indexer_schema_migrations WHERE name=$1 FOR UPDATE",
        [migrationName],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error("Applied indexer migration checksum does not match source");
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO indexer_schema_migrations (name,checksum) VALUES ($1,$2)", [
        migrationName,
        checksum,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", service: "indexer-migration", message: error instanceof Error ? error.message : "Migration failed" })}\n`,
  );
  process.exitCode = 1;
});
