import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { Hex } from "viem";
import { FinalizedIndexer } from "./indexer.js";
import { ConservationReconciler } from "./reconciliation.js";
import type { FinalizedChainSource } from "./source.js";
import { PgIndexerStore } from "./store.js";
import type { IndexedContracts } from "./types.js";

type Queryable = Pick<Pool, "query">;

const projectionTables = [
  "payment_projections",
  "payment_cancellations",
  "channel_projections",
  "voucher_projections",
  "refund_projections",
  "withdrawal_projections",
  "projection_totals",
  "balanced_journal_batches",
] as const;

export type RebuildPlan = {
  rebuildId: string;
  streamId: string;
  shadowSchema: string;
  targetBlock: bigint;
  targetBlockHash: Hex;
  changedTables: readonly string[];
  sourceFingerprint: Record<string, string>;
  shadowFingerprint: Record<string, string>;
  planDigest: string;
};

export class ProjectionRebuildRejected extends Error {}
export class ProjectionPromotionRejected extends Error {}

function schemaName(rebuildId: string) {
  const value = `indexer_shadow_${rebuildId.replaceAll("-", "")}`;
  if (!/^indexer_shadow_[0-9a-f]{32}$/.test(value)) throw new Error("Invalid rebuild identifier");
  return value;
}

function digest(input: Omit<RebuildPlan, "planDigest">) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        targetBlock: input.targetBlock.toString(),
        targetBlockHash: input.targetBlockHash.toLowerCase(),
      }),
    )
    .digest("hex");
}

function shadowPool(databaseUrl: string, schema: string) {
  return new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
}

class PinnedSource implements FinalizedChainSource {
  constructor(
    private readonly source: FinalizedChainSource,
    private readonly targetBlock: bigint,
  ) {}

  assertManifest(input: { chainId: bigint; eventId: Hex; contracts: IndexedContracts }) {
    return this.source.assertManifest(input);
  }
  getFinalizedHead() {
    return this.source.getBlock(this.targetBlock);
  }
  getLatestHead() {
    return this.source.getLatestHead();
  }
  getBlock(blockNumber: bigint) {
    return this.source.getBlock(blockNumber);
  }
  getLogs(fromBlock: bigint, toBlock: bigint) {
    return this.source.getLogs(fromBlock, toBlock);
  }
  readConservation(blockNumber: bigint) {
    return this.source.readConservation(blockNumber);
  }
}

export class ProjectionRebuildService {
  constructor(
    private readonly primary: Pool,
    private readonly databaseUrl: string,
  ) {}

  async rebuild(input: {
    streamId: string;
    chainId: bigint;
    eventId: Hex;
    contracts: IndexedContracts;
    deploymentBlock: bigint;
    batchSize: number;
    source: FinalizedChainSource;
    requestedBy: string;
  }): Promise<RebuildPlan> {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.requestedBy))
      throw new Error("Invalid rebuild operator");
    const cursor = await this.primary.query(
      "SELECT block_number,block_hash FROM indexer_cursors WHERE stream_id=$1",
      [input.streamId],
    );
    if (cursor.rowCount !== 1) throw new ProjectionRebuildRejected("Finalized cursor is missing");
    const targetBlock = BigInt(cursor.rows[0].block_number);
    const targetBlockHash = cursor.rows[0].block_hash as Hex;
    const rebuildId = randomUUID();
    const schema = schemaName(rebuildId);
    const migration = await readFile(
      new URL("../migrations/001_finalized_indexer.sql", import.meta.url),
      "utf8",
    );
    const setup = await this.primary.connect();
    try {
      await setup.query("BEGIN");
      await setup.query(`CREATE SCHEMA ${schema}`);
      await setup.query(`SET LOCAL search_path TO ${schema}`);
      await setup.query(migration);
      await setup.query(
        `INSERT INTO public.projection_rebuilds
          (rebuild_id,stream_id,shadow_schema,requested_by,state,target_block,target_block_hash)
         VALUES ($1,$2,$3,$4,'BUILDING',$5,$6)`,
        [
          rebuildId,
          input.streamId,
          schema,
          input.requestedBy,
          targetBlock.toString(),
          targetBlockHash,
        ],
      );
      await setup.query("COMMIT");
    } catch (error) {
      await setup.query("ROLLBACK");
      throw error;
    } finally {
      setup.release();
    }

    const pool = shadowPool(this.databaseUrl, schema);
    try {
      const source = new PinnedSource(input.source, targetBlock);
      const store = new PgIndexerStore(pool);
      const indexer = new FinalizedIndexer({ ...input, source, store });
      for (;;) {
        const result = await indexer.runOnce();
        if (result.caughtUp) break;
      }
      const reconciliation = await new ConservationReconciler(
        input.streamId,
        source,
        store,
      ).runAtCursor();
      if (!reconciliation || reconciliation.differences.length > 0)
        return await this.#reject(rebuildId, "shadow_conservation_mismatch");
      if (!(await this.#historyMatches(input.streamId, schema)))
        return await this.#reject(rebuildId, "shadow_history_mismatch");
      const changedTables = await this.#changedTables(input.streamId, schema);
      const sourceFingerprint = await this.#fingerprint(input.streamId, null);
      const shadowFingerprint = await this.#fingerprint(input.streamId, schema);
      const unsigned = {
        rebuildId,
        streamId: input.streamId,
        shadowSchema: schema,
        targetBlock,
        targetBlockHash,
        changedTables,
        sourceFingerprint,
        shadowFingerprint,
      };
      const planDigest = digest(unsigned);
      const updated = await this.primary.query(
        `UPDATE projection_rebuilds SET state='READY',plan_digest=$2,changed_tables=$3::jsonb,
           source_fingerprint=$4::jsonb,shadow_fingerprint=$5::jsonb,
           ready_at=clock_timestamp()
         WHERE rebuild_id=$1 AND state='BUILDING' RETURNING rebuild_id`,
        [
          rebuildId,
          planDigest,
          JSON.stringify(changedTables),
          JSON.stringify(sourceFingerprint),
          JSON.stringify(shadowFingerprint),
        ],
      );
      if (updated.rowCount !== 1) throw new ProjectionRebuildRejected("Rebuild state changed");
      return { ...unsigned, planDigest };
    } catch (error) {
      await this.primary.query(
        `UPDATE projection_rebuilds SET state='REJECTED',rejection_code='rebuild_failed'
         WHERE rebuild_id=$1 AND state='BUILDING'`,
        [rebuildId],
      );
      throw error;
    } finally {
      await pool.end();
    }
  }

  async promote(rebuildId: string, expectedPlanDigest: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(expectedPlanDigest))
      throw new ProjectionPromotionRejected("Invalid expected plan digest");
    const client = await this.primary.connect();
    try {
      await client.query("BEGIN");
      const planResult = await client.query(
        "SELECT * FROM projection_rebuilds WHERE rebuild_id=$1 FOR UPDATE",
        [rebuildId],
      );
      const row = planResult.rows[0];
      if (row?.state !== "READY" || row.plan_digest !== expectedPlanDigest)
        throw new ProjectionPromotionRejected("Rebuild plan is not approved for promotion");
      const schema = String(row.shadow_schema);
      if (schema !== schemaName(rebuildId))
        throw new ProjectionPromotionRejected("Shadow schema mismatch");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [row.stream_id]);
      const cursor = await client.query(
        "SELECT block_number,block_hash FROM indexer_cursors WHERE stream_id=$1 FOR UPDATE",
        [row.stream_id],
      );
      if (
        cursor.rowCount !== 1 ||
        BigInt(cursor.rows[0].block_number) !== BigInt(row.target_block) ||
        String(cursor.rows[0].block_hash).toLowerCase() !==
          String(row.target_block_hash).toLowerCase()
      )
        throw new ProjectionPromotionRejected("Finalized cursor changed after rebuild");
      if (!(await this.#historyMatches(row.stream_id, schema, client)))
        throw new ProjectionPromotionRejected("Finalized history changed after rebuild");
      const changedTables = await this.#changedTables(row.stream_id, schema, client);
      const sourceFingerprint = await this.#fingerprint(row.stream_id, null, client);
      const shadowFingerprint = await this.#fingerprint(row.stream_id, schema, client);
      const currentDigest = digest({
        rebuildId,
        streamId: row.stream_id,
        shadowSchema: schema,
        targetBlock: BigInt(row.target_block),
        targetBlockHash: row.target_block_hash as Hex,
        changedTables,
        sourceFingerprint,
        shadowFingerprint,
      });
      if (currentDigest !== expectedPlanDigest)
        throw new ProjectionPromotionRejected("Projection data changed after rebuild approval");
      await this.#replaceProjections(client, row.stream_id, schema);
      await client.query(
        `UPDATE projection_rebuilds SET state='PROMOTED',promoted_at=clock_timestamp()
         WHERE rebuild_id=$1`,
        [rebuildId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #reject(rebuildId: string, code: string): Promise<never> {
    await this.primary.query(
      `UPDATE projection_rebuilds SET state='REJECTED',rejection_code=$2
       WHERE rebuild_id=$1 AND state='BUILDING'`,
      [rebuildId, code],
    );
    throw new ProjectionRebuildRejected(code);
  }

  async #historyMatches(streamId: string, schema: string, query: Queryable = this.primary) {
    const result = await query.query(
      `SELECT NOT EXISTS (
         (SELECT transition_id,payload FROM finalized_chain_logs WHERE stream_id=$1
          EXCEPT SELECT transition_id,payload FROM ${schema}.finalized_chain_logs WHERE stream_id=$1)
         UNION ALL
         (SELECT transition_id,payload FROM ${schema}.finalized_chain_logs WHERE stream_id=$1
          EXCEPT SELECT transition_id,payload FROM finalized_chain_logs WHERE stream_id=$1)
       ) AS matches`,
      [streamId],
    );
    return result.rows[0]?.matches === true;
  }

  async #changedTables(streamId: string, schema: string, query: Queryable = this.primary) {
    const changed: string[] = [];
    for (const table of projectionTables) {
      const result = await query.query(
        `SELECT EXISTS (
           (SELECT to_jsonb(p)-'updated_at' FROM ${table} p WHERE stream_id=$1
            EXCEPT SELECT to_jsonb(s)-'updated_at' FROM ${schema}.${table} s WHERE stream_id=$1)
           UNION ALL
           (SELECT to_jsonb(s)-'updated_at' FROM ${schema}.${table} s WHERE stream_id=$1
            EXCEPT SELECT to_jsonb(p)-'updated_at' FROM ${table} p WHERE stream_id=$1)
         ) AS changed`,
        [streamId],
      );
      if (result.rows[0]?.changed === true) changed.push(table);
    }
    const journal = await query.query(
      `SELECT EXISTS (
         (SELECT to_jsonb(e) FROM balanced_journal_entries e JOIN balanced_journal_batches b USING (transition_id)
          WHERE b.stream_id=$1
          EXCEPT SELECT to_jsonb(e) FROM ${schema}.balanced_journal_entries e
            JOIN ${schema}.balanced_journal_batches b USING (transition_id) WHERE b.stream_id=$1)
         UNION ALL
         (SELECT to_jsonb(e) FROM ${schema}.balanced_journal_entries e
            JOIN ${schema}.balanced_journal_batches b USING (transition_id) WHERE b.stream_id=$1
          EXCEPT SELECT to_jsonb(e) FROM balanced_journal_entries e JOIN balanced_journal_batches b USING (transition_id)
            WHERE b.stream_id=$1)
       ) AS changed`,
      [streamId],
    );
    if (journal.rows[0]?.changed === true) changed.push("balanced_journal_entries");
    return changed.sort();
  }

  async #fingerprint(streamId: string, schema: string | null, query: Queryable = this.primary) {
    const prefix = schema ? `${schema}.` : "";
    const fingerprint: Record<string, string> = {};
    for (const table of projectionTables) {
      const result = await query.query(
        `SELECT COUNT(*)::text AS count,
                md5(COALESCE(string_agg(value,'' ORDER BY value),'')) AS checksum
         FROM (SELECT (to_jsonb(t)-'updated_at')::text AS value
               FROM ${prefix}${table} t WHERE stream_id=$1) rows`,
        [streamId],
      );
      fingerprint[table] = `${result.rows[0].count}:${result.rows[0].checksum}`;
    }
    const journal = await query.query(
      `SELECT COUNT(*)::text AS count,
              md5(COALESCE(string_agg(value,'' ORDER BY value),'')) AS checksum
       FROM (SELECT to_jsonb(e)::text AS value FROM ${prefix}balanced_journal_entries e
             JOIN ${prefix}balanced_journal_batches b USING (transition_id)
             WHERE b.stream_id=$1) rows`,
      [streamId],
    );
    fingerprint.balanced_journal_entries = `${journal.rows[0].count}:${journal.rows[0].checksum}`;
    return fingerprint;
  }

  async #replaceProjections(client: import("pg").PoolClient, streamId: string, schema: string) {
    await client.query("DELETE FROM refund_projections WHERE stream_id=$1", [streamId]);
    await client.query("DELETE FROM voucher_projections WHERE stream_id=$1", [streamId]);
    await client.query("DELETE FROM payment_projections WHERE stream_id=$1", [streamId]);
    await client.query("DELETE FROM payment_cancellations WHERE stream_id=$1", [streamId]);
    await client.query("DELETE FROM channel_projections WHERE stream_id=$1", [streamId]);
    await client.query("DELETE FROM withdrawal_projections WHERE stream_id=$1", [streamId]);
    await client.query(
      "DELETE FROM balanced_journal_entries WHERE transition_id IN (SELECT transition_id FROM balanced_journal_batches WHERE stream_id=$1)",
      [streamId],
    );
    await client.query("DELETE FROM balanced_journal_batches WHERE stream_id=$1", [streamId]);
    await client.query("DELETE FROM projection_totals WHERE stream_id=$1", [streamId]);
    for (const table of [
      "payment_cancellations",
      "channel_projections",
      "payment_projections",
      "voucher_projections",
      "refund_projections",
      "withdrawal_projections",
      "projection_totals",
      "balanced_journal_batches",
      "balanced_journal_entries",
    ])
      await client.query(
        `INSERT INTO ${table} SELECT s.* FROM ${schema}.${table} s ${
          table === "balanced_journal_entries"
            ? `JOIN ${schema}.balanced_journal_batches b USING (transition_id) WHERE b.stream_id=$1`
            : "WHERE s.stream_id=$1"
        }`,
        [streamId],
      );
  }
}
