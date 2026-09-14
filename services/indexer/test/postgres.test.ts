import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { Address, Hex } from "viem";
import { expect, it } from "vitest";
import { ProjectionRebuildService } from "../src/rebuild.js";
import type { FinalizedChainSource } from "../src/source.js";
import { PgIndexerStore } from "../src/store.js";
import type { IndexedTransition } from "../src/types.js";

const databaseUrl = process.env.INDEXER_TEST_DATABASE_URL;
const eligible = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  return (
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
    url.pathname.toLowerCase().includes("test")
  );
})();
const postgresIt = eligible ? it : it.skip;
const hash = (nibble: string) => `0x${nibble.repeat(64)}` as Hex;
const address = (digit: string) => `0x${digit.repeat(40)}` as Address;

postgresIt(
  "commits projections, balanced journals, outbox, and reconciliation atomically",
  async () => {
    if (!databaseUrl) throw new Error("Missing isolated indexer test database");
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const streamId = `test:${randomUUID()}`;
    const blockHash = hash("a");
    const base = (id: number, contract: Address) => ({
      transitionId: `${streamId}:${id}`,
      chainId: 10_143n,
      eventId: hash("e"),
      address: contract,
      blockNumber: 10n,
      blockHash,
      transactionHash: hash(String(id)),
      transactionIndex: id,
      logIndex: 0,
    });
    const paymentId = hash("1");
    const channelId = hash("2");
    const transitions: IndexedTransition[] = [
      {
        ...base(1, address("1")),
        kind: "PAYMENT_COMMITTED",
        paymentId,
        payer: address("4"),
        vendorId: hash("5"),
        configVersion: 1n,
        grossUnits: 100n,
        organizerFeeUnits: 3n,
        platformFeeUnits: 2n,
        receiptCommitment: hash("6"),
      },
      {
        ...base(2, address("3")),
        kind: "CHANNEL_OPENED",
        channelId,
        originalAccount: address("4"),
        vendorId: hash("5"),
        terminalInstanceId: hash("7"),
        reserveUnits: 500n,
        acceptUntil: 200,
        submitUntil: 300,
      },
      {
        ...base(3, address("3")),
        kind: "VOUCHER_SETTLED",
        channelId,
        paymentId: hash("3"),
        sequence: 1,
        grossUnits: 50n,
        cumulativeGrossUnits: 50n,
        voucherDigest: hash("8"),
      },
      {
        ...base(4, address("1")),
        kind: "REFUND_COMMITTED",
        refundId: hash("9"),
        paymentId,
        payer: address("4"),
        amountUnits: 30n,
        vendorCreditUnits: 20n,
      },
      {
        ...base(5, address("2")),
        kind: "WITHDRAWN",
        beneficiaryId: hash("b"),
        destination: address("5"),
        amountUnits: 30n,
      },
      {
        ...base(6, address("3")),
        kind: "CHANNEL_RECLAIMED",
        channelId,
        originalAccount: address("4"),
        returnedUnits: 450n,
      },
    ];
    try {
      const migration = await readFile(
        new URL("../migrations/001_finalized_indexer.sql", import.meta.url),
        "utf8",
      );
      if (!(await pool.query("SELECT to_regclass('public.indexer_cursors') AS name")).rows[0]?.name)
        await pool.query(migration);
      const store = new PgIndexerStore(pool);
      await store.assertReady();
      await store.commitFinalizedBatch({
        streamId,
        chainId: 10_143n,
        deploymentBlock: 10n,
        fromBlock: 10n,
        toBlock: 10n,
        endBlockHash: blockHash,
        transitions,
      });
      const expected = await store.getExpectedConservation(streamId);
      expect(expected).toEqual({
        cursor: { blockNumber: 10n, blockHash },
        snapshot: { ledgerLiabilityUnits: 100n, vaultReservedUnits: 0n },
      });
      const run = {
        runId: randomUUID(),
        blockNumber: 10n,
        blockHash,
        expected: expected?.snapshot ?? { ledgerLiabilityUnits: -1n, vaultReservedUnits: -1n },
        actual: { ledgerLiabilityUnits: 100n, vaultReservedUnits: 0n },
        differences: [] as const,
      };
      await store.recordReconciliation(run, streamId);
      const evidence = await pool.query(
        `SELECT
           (SELECT count(*) FROM finalized_chain_logs WHERE stream_id=$1) AS logs,
           (SELECT count(*) FROM balanced_journal_batches WHERE stream_id=$1) AS journals,
           (SELECT count(*) FROM transition_outbox WHERE stream_id=$1) AS outbox,
           (SELECT status FROM reconciliation_runs WHERE stream_id=$1) AS reconciliation`,
        [streamId],
      );
      expect(evidence.rows[0]).toMatchObject({
        logs: "6",
        journals: "6",
        outbox: "6",
        reconciliation: "MATCHED",
      });
    } finally {
      await pool.end();
    }
  },
  15_000,
);

postgresIt(
  "rebuilds and promotes a verified shadow projection with explicit plan approval",
  async () => {
    if (!databaseUrl) throw new Error("Missing isolated indexer test database");
    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const streamId = `test:${randomUUID()}`;
    const blockHash = hash("d");
    try {
      for (const name of ["001_finalized_indexer", "003_projection_rebuilds"]) {
        const migration = await readFile(
          new URL(`../migrations/${name}.sql`, import.meta.url),
          "utf8",
        );
        const relation =
          name === "001_finalized_indexer" ? "indexer_cursors" : "projection_rebuilds";
        if (!(await pool.query("SELECT to_regclass($1) AS name", [relation])).rows[0]?.name)
          await pool.query(migration);
      }
      const store = new PgIndexerStore(pool);
      await store.commitFinalizedBatch({
        streamId,
        chainId: 10_143n,
        deploymentBlock: 10n,
        fromBlock: 10n,
        toBlock: 10n,
        endBlockHash: blockHash,
        transitions: [],
      });
      await pool.query("UPDATE projection_totals SET ledger_liability_units=1 WHERE stream_id=$1", [
        streamId,
      ]);
      const source: FinalizedChainSource = {
        async assertManifest() {},
        async getFinalizedHead() {
          return this.getBlock(10n);
        },
        async getLatestHead() {
          return this.getBlock(10n);
        },
        async getBlock(number) {
          return { number, hash: blockHash, parentHash: hash("c"), timestamp: 1n };
        },
        async getLogs() {
          return [];
        },
        async readConservation() {
          return { ledgerLiabilityUnits: 0n, vaultReservedUnits: 0n };
        },
      };
      const service = new ProjectionRebuildService(pool, databaseUrl);
      const plan = await service.rebuild({
        streamId,
        chainId: 10_143n,
        eventId: hash("e"),
        contracts: { router: address("1"), ledger: address("2"), vault: address("3") },
        deploymentBlock: 10n,
        batchSize: 10,
        source,
        requestedBy: "operator:test",
      });
      expect(plan.changedTables).toContain("projection_totals");
      await service.promote(plan.rebuildId, plan.planDigest);
      const result = await pool.query(
        `SELECT p.ledger_liability_units,r.state FROM projection_totals p
         JOIN projection_rebuilds r ON r.stream_id=p.stream_id
         WHERE p.stream_id=$1`,
        [streamId],
      );
      expect(result.rows[0]).toMatchObject({ ledger_liability_units: "0", state: "PROMOTED" });
    } finally {
      await pool.end();
    }
  },
  20_000,
);
