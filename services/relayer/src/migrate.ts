import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadRelayerDatabaseConfig } from "./config.js";

const migrationName = "001_financial_operations";

async function migrate() {
  const config = loadRelayerDatabaseConfig(process.env);
  const sql = await readFile(
    new URL("../migrations/001_financial_operations.sql", import.meta.url),
    "utf8",
  );
  const checksum = createHash("sha256").update(sql).digest("hex");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    application_name: "openbalance-relayer-migration",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(948203117)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS relayer_schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    const existing = await client.query(
      "SELECT checksum FROM relayer_schema_migrations WHERE name=$1 FOR UPDATE",
      [migrationName],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum)
        throw new Error("Applied relayer migration checksum does not match source");
    } else {
      await client.query(sql);
      await client.query("INSERT INTO relayer_schema_migrations (name,checksum) VALUES ($1,$2)", [
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
    `${JSON.stringify({ level: "error", service: "relayer-migration", message: error instanceof Error ? error.message : "Migration failed" })}\n`,
  );
  process.exitCode = 1;
});
