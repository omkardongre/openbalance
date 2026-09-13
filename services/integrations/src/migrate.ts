import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";

const environment = z
  .object({ INTEGRATION_DATABASE_URL: z.string().min(1) })
  .passthrough()
  .parse(process.env);
const name = "001_integration_jobs";

async function migrate() {
  const sql = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const pool = new Pool({ connectionString: environment.INTEGRATION_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(183746291)");
    await client.query(`CREATE TABLE IF NOT EXISTS integration_schema_migrations
      (name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const existing = await client.query(
      "SELECT checksum FROM integration_schema_migrations WHERE name=$1 FOR UPDATE",
      [name],
    );
    if (existing.rows[0] && existing.rows[0].checksum !== checksum)
      throw new Error("Applied integration migration checksum does not match source");
    if (!existing.rows[0]) {
      await client.query(sql);
      await client.query(
        "INSERT INTO integration_schema_migrations (name,checksum) VALUES ($1,$2)",
        [name, checksum],
      );
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
    `${JSON.stringify({ level: "error", service: "integration-migration", message: error instanceof Error ? error.message : "Migration failed" })}\n`,
  );
  process.exitCode = 1;
});
