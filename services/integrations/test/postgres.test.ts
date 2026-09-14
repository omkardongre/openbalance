import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { IntegrationJobConflict, IntegrationJobJournal } from "../src/journal.js";
import { FinalizedPaymentImporter } from "../src/source.js";

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
    const transitionId = `test:transition:${randomUUID()}`;
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
        transitionId,
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
      const lease = await journal.lease("worker:test", new Date());
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
      await pool.query("DELETE FROM integration_attempts WHERE transition_id=$1", [transitionId]);
      await pool.query("DELETE FROM integration_jobs WHERE transition_id=$1", [transitionId]);
      await pool.end();
    }
  },
  15_000,
);

postgresIt("imports only a finalized payment with an exact ready checkout mapping", async () => {
  if (!databaseUrl) throw new Error("Missing isolated integration test database");
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const streamId = `test:10143:${randomUUID()}`;
  const transitionId = `payment:${randomUUID()}`;
  const orderId = randomUUID();
  const eventId = `0x${"4".repeat(64)}` as const;
  const vendorId = `0x${"5".repeat(64)}` as const;
  const paymentId = `0x${"6".repeat(64)}` as const;
  try {
    const journal = new IntegrationJobJournal(pool);
    const importer = new FinalizedPaymentImporter(pool, pool, pool, journal, [
      { streamId, eventId, vendorId, company: "OpenBalance Test", assetCode: "USDC" },
    ]);
    await importer.assertReady();
    await pool.query(
      `INSERT INTO finalized_chain_logs
       (transition_id,stream_id,chain_id,event_id,contract_address,block_number,block_hash,
        transaction_hash,transaction_index,log_index,transition_kind,payload)
       VALUES ($1,$2,10143,$3,$4,50,$5,$6,1,2,'PAYMENT_COMMITTED','{}')`,
      [
        transitionId,
        streamId,
        eventId,
        `0x${"7".repeat(40)}`,
        `0x${"8".repeat(64)}`,
        `0x${"9".repeat(64)}`,
      ],
    );
    await pool.query(
      `INSERT INTO payment_projections
       (stream_id,payment_id,mode,payer,vendor_id,gross_units,organizer_fee_units,
        platform_fee_units,allocation_status,transition_id,transaction_hash,block_number)
       VALUES ($1,$2,'ONLINE',$3,$4,12500000,400000,100000,'EVENT_VERIFIED',$5,$6,50)`,
      [streamId, paymentId, `0x${"a".repeat(40)}`, vendorId, transitionId, `0x${"9".repeat(64)}`],
    );
    await pool.query(
      `INSERT INTO checkout_orders
       (order_id,stream_id,event_id,vendor_id,terminal_instance_id,payment_id,payer_account,
        order_ref_hash,order_version,gross_units,encoded_intent,display,reserve_policy,state,
        terminal_signature,capability_hash,created_by,idempotency_key,request_hash,expires_at,
        bound_at,ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,12500000,$9,$10::jsonb,'{}'::jsonb,'READY',$11,
        $12,'vendor:test','integration-checkout-0001',$13,clock_timestamp()+interval '1 hour',
        clock_timestamp(),clock_timestamp())`,
      [
        orderId,
        streamId,
        eventId,
        vendorId,
        `0x${"b".repeat(64)}`,
        paymentId,
        `0x${"a".repeat(40)}`,
        `0x${"c".repeat(64)}`,
        "0x01",
        JSON.stringify({ orderReference: "ORDER-ERP-1" }),
        `0x${"dd".repeat(65)}`,
        "e".repeat(64),
        `0x${"f".repeat(64)}`,
      ],
    );
    await expect(importer.importOnce(streamId)).resolves.toBe(1);
    const job = await pool.query("SELECT payload FROM integration_jobs WHERE transition_id=$1", [
      transitionId,
    ]);
    expect(job.rows[0]?.payload).toMatchObject({
      orderReference: "ORDER-ERP-1",
      amountUnits: "12500000",
      paymentId,
    });
  } finally {
    await pool.query("DELETE FROM integration_source_cursors WHERE stream_id=$1", [streamId]);
    await pool.query("DELETE FROM integration_attempts WHERE transition_id=$1", [transitionId]);
    await pool.query("DELETE FROM integration_jobs WHERE transition_id=$1", [transitionId]);
    await pool.query("DELETE FROM checkout_orders WHERE order_id=$1", [orderId]);
    await pool.query("DELETE FROM payment_projections WHERE stream_id=$1", [streamId]);
    await pool.query("DELETE FROM finalized_chain_logs WHERE stream_id=$1", [streamId]);
    await pool.end();
  }
});
