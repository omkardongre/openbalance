import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";

const migrations = [
  "001_enrollment",
  "002_account_deployments",
  "003_account_access",
  "004_deployment_sponsorship",
  "005_operational_access_and_incidents",
  "006_checkout_orders",
  "007_organizer_configuration",
  "008_terminal_order_import",
] as const;

const environment = z
  .object({ DATABASE_URL: z.string().min(1) })
  .passthrough()
  .parse(process.env);

async function migrate() {
  const pool = new Pool({
    connectionString: environment.DATABASE_URL,
    max: 1,
    application_name: "openbalance-api-migration",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(948203116)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS api_schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    for (const name of migrations) {
      const sql = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM api_schema_migrations WHERE name=$1 FOR UPDATE",
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error("Applied API migration checksum does not match source");
        continue;
      }
      const executable = sql.replace(/^\s*BEGIN;\s*/i, "").replace(/\s*COMMIT;\s*$/i, "");
      await client.query(executable);
      await client.query("INSERT INTO api_schema_migrations (name,checksum) VALUES ($1,$2)", [
        name,
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
    `${JSON.stringify({ level: "error", service: "api-migration", message: error instanceof Error ? error.message : "Migration failed" })}\n`,
  );
  process.exitCode = 1;
});
