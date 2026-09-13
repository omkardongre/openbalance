import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { IntegrationJobConflict, IntegrationJobJournal } from "../src/journal.js";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const eligible = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && url.pathname.includes("test");
})();
const postgresIt = eligible ? it : it.skip;

postgresIt(
  "persists idempotent integration delivery with fenced completion",
  async () => {
    if (!databaseUrl) throw new Error("Missing isolated integration test database");
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const sql = await readFile(
        new URL("../migrations/001_integration_jobs.sql", import.meta.url),
        "utf8",
      );
      if (
        !(await pool.query("SELECT to_regclass('public.integration_jobs') AS name")).rows[0]?.name
      )
        await pool.query(sql);
      const journal = new IntegrationJobJournal(pool);
      await journal.assertReady();
      const payment = {
        transitionId: "test:transition:1",
        company: "OpenBalance Test",
        orderReference: "ORDER-1",
        paymentId: `0x${"1".repeat(64)}` as const,
        payer: "0x1111111111111111111111111111111111111111" as const,
        amountUnits: 12_000_000n,
        assetCode: "USDC",
        chainId: 10_143n,
        transactionHash: `0x${"2".repeat(64)}` as const,
        blockNumber: 42n,
        blockHash: `0x${"3".repeat(64)}` as const,
      };
      await expect(journal.enqueue(payment)).resolves.toEqual({ created: true });
      await expect(journal.enqueue(payment)).resolves.toEqual({ created: false });
      await expect(journal.enqueue({ ...payment, amountUnits: 1n })).rejects.toBeInstanceOf(
        IntegrationJobConflict,
      );
      const lease = await journal.lease("worker:test", new Date("2026-09-13T10:00:00Z"));
      expect(lease).toMatchObject({
        transitionId: payment.transitionId,
        attempts: 1,
        state: "LEASED",
      });
      if (!lease) throw new Error("Expected an integration lease");
      await journal.complete(lease, { salesInvoice: "SINV-1", paymentEntry: "PAY-1" });
      const stored = await pool.query(
        "SELECT state,sales_invoice,payment_entry FROM integration_jobs WHERE transition_id=$1",
        [payment.transitionId],
      );
      expect(stored.rows[0]).toMatchObject({
        state: "COMPLETED",
        sales_invoice: "SINV-1",
        payment_entry: "PAY-1",
      });
    } finally {
      await pool.end();
    }
  },
  15_000,
);
