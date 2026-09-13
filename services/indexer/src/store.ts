import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Hex } from "viem";
import type { ProvisionalStore } from "./provisional.js";
import type {
  ConservationSnapshot,
  IndexedTransition,
  IndexerCursor,
  ReconciliationResult,
} from "./types.js";

export type FinalizedBatch = {
  streamId: string;
  chainId: bigint;
  deploymentBlock: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  endBlockHash: Hex;
  transitions: readonly IndexedTransition[];
};

export type IntegrityIncidentInput = {
  streamId: string;
  code: "FINALIZED_HISTORY_CONTRADICTION" | "CONSERVATION_MISMATCH";
  message: string;
  blockNumber?: bigint;
  expectedBlockHash?: Hex;
  observedBlockHash?: Hex;
};

export interface IndexerStore {
  getCursor(streamId: string): Promise<IndexerCursor | null>;
  commitFinalizedBatch(batch: FinalizedBatch): Promise<void>;
  getExpectedConservation(
    streamId: string,
  ): Promise<{ cursor: IndexerCursor; snapshot: ConservationSnapshot } | null>;
  recordReconciliation(result: ReconciliationResult, streamId: string): Promise<void>;
  recordIntegrityIncident(incident: IntegrityIncidentInput): Promise<void>;
}

type JournalLine = {
  account: string;
  side: "DEBIT" | "CREDIT";
  units: bigint;
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

function journalLines(transition: IndexedTransition): JournalLine[] {
  switch (transition.kind) {
    case "PAYMENT_COMMITTED":
      return [
        { account: "asset:ledger-custody", side: "DEBIT", units: transition.grossUnits },
        { account: "liability:ledger-beneficiaries", side: "CREDIT", units: transition.grossUnits },
      ];
    case "CHANNEL_OPENED":
      return [
        { account: "asset:vault-custody", side: "DEBIT", units: transition.reserveUnits },
        { account: "liability:vault-reserves", side: "CREDIT", units: transition.reserveUnits },
      ];
    case "VOUCHER_SETTLED":
      return [
        { account: "asset:ledger-custody", side: "DEBIT", units: transition.grossUnits },
        { account: "liability:vault-reserves", side: "DEBIT", units: transition.grossUnits },
        { account: "asset:vault-custody", side: "CREDIT", units: transition.grossUnits },
        { account: "liability:ledger-beneficiaries", side: "CREDIT", units: transition.grossUnits },
      ];
    case "REFUND_COMMITTED":
      return transition.vendorCreditUnits === 0n
        ? []
        : [
            {
              account: "liability:ledger-beneficiaries",
              side: "DEBIT",
              units: transition.vendorCreditUnits,
            },
            {
              account: "asset:ledger-custody",
              side: "CREDIT",
              units: transition.vendorCreditUnits,
            },
          ];
    case "CHANNEL_RECLAIMED":
      return [
        { account: "liability:vault-reserves", side: "DEBIT", units: transition.returnedUnits },
        { account: "asset:vault-custody", side: "CREDIT", units: transition.returnedUnits },
      ];
    case "WITHDRAWN":
      return [
        { account: "liability:ledger-beneficiaries", side: "DEBIT", units: transition.amountUnits },
        { account: "asset:ledger-custody", side: "CREDIT", units: transition.amountUnits },
      ];
    case "PAYMENT_CANCELLED":
      return [];
  }
}

async function requireOne(operation: Promise<{ rowCount: number | null }>, message: string) {
  const result = await operation;
  if (result.rowCount !== 1) throw new Error(message);
}

function incidentId(incident: IntegrityIncidentInput): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        streamId: incident.streamId,
        code: incident.code,
        blockNumber: incident.blockNumber,
        expectedBlockHash: incident.expectedBlockHash?.toLowerCase(),
        observedBlockHash: incident.observedBlockHash?.toLowerCase(),
      }),
    )
    .digest("hex");
}

async function writeIncident(client: Pool | PoolClient, incident: IntegrityIncidentInput) {
  if (incident.message.length < 1 || incident.message.length > 500)
    throw new Error("Invalid integrity incident message");
  await client.query(
    `INSERT INTO integrity_incidents
      (incident_id,stream_id,code,severity,block_number,expected_block_hash,observed_block_hash,message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (stream_id,code) WHERE status='OPEN' DO UPDATE SET
       severity=EXCLUDED.severity,
       block_number=EXCLUDED.block_number,
       expected_block_hash=EXCLUDED.expected_block_hash,
       observed_block_hash=EXCLUDED.observed_block_hash,
       message=EXCLUDED.message`,
    [
      incidentId(incident),
      incident.streamId,
      incident.code,
      incident.code === "FINALIZED_HISTORY_CONTRADICTION" ? "CRITICAL" : "HIGH",
      incident.blockNumber?.toString() ?? null,
      incident.expectedBlockHash?.toLowerCase() ?? null,
      incident.observedBlockHash?.toLowerCase() ?? null,
      incident.message,
    ],
  );
}

export class PgIndexerStore implements IndexerStore, ProvisionalStore {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      "SELECT to_regclass('public.indexer_cursors') AS cursors, to_regclass('public.finalized_chain_logs') AS logs",
    );
    if (!result.rows[0]?.cursors || !result.rows[0]?.logs)
      throw new Error("Indexer database migration is not installed");
  }

  async getCursor(streamId: string): Promise<IndexerCursor | null> {
    const result = await this.pool.query(
      "SELECT block_number,block_hash FROM indexer_cursors WHERE stream_id=$1",
      [streamId],
    );
    const row = result.rows[0];
    return row ? { blockNumber: BigInt(row.block_number), blockHash: row.block_hash as Hex } : null;
  }

  async getProvisionalCursor(streamId: string): Promise<IndexerCursor | null> {
    const result = await this.pool.query(
      "SELECT block_number,block_hash FROM provisional_cursors WHERE stream_id=$1",
      [streamId],
    );
    const row = result.rows[0];
    return row ? { blockNumber: BigInt(row.block_number), blockHash: row.block_hash as Hex } : null;
  }

  getFinalizedCursor(streamId: string): Promise<IndexerCursor | null> {
    return this.getCursor(streamId);
  }

  async getProvisionalBlock(streamId: string, blockNumber: bigint) {
    const result = await this.pool.query(
      `SELECT block_number,block_hash,parent_hash FROM provisional_blocks
       WHERE stream_id=$1 AND block_number=$2`,
      [streamId, blockNumber.toString()],
    );
    const row = result.rows[0];
    return row
      ? {
          blockNumber: BigInt(row.block_number),
          blockHash: row.block_hash as Hex,
          parentHash: row.parent_hash as Hex,
        }
      : null;
  }

  async replaceProvisionalTail(input: {
    streamId: string;
    chainId: bigint;
    eventId: Hex;
    ancestorBlock: bigint | null;
    blocks: readonly { blockNumber: bigint; blockHash: Hex; parentHash: Hex }[];
    transitions: readonly IndexedTransition[];
  }): Promise<void> {
    if (input.blocks.length === 0) throw new Error("Provisional batch is empty");
    const first = input.blocks[0];
    const last = input.blocks.at(-1);
    if (!first || !last) throw new Error("Provisional batch is empty");
    if (input.ancestorBlock !== null && first.blockNumber !== input.ancestorBlock + 1n)
      throw new Error("Provisional batch does not extend its ancestor");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.streamId]);
      const deleteAfter = input.ancestorBlock?.toString() ?? "-1";
      await client.query(
        "DELETE FROM provisional_chain_logs WHERE stream_id=$1 AND block_number>$2",
        [input.streamId, deleteAfter],
      );
      await client.query("DELETE FROM provisional_blocks WHERE stream_id=$1 AND block_number>$2", [
        input.streamId,
        deleteAfter,
      ]);
      for (const block of input.blocks)
        await client.query(
          `INSERT INTO provisional_blocks (stream_id,block_number,block_hash,parent_hash)
           VALUES ($1,$2,$3,$4)`,
          [
            input.streamId,
            block.blockNumber.toString(),
            block.blockHash.toLowerCase(),
            block.parentHash.toLowerCase(),
          ],
        );
      for (const transition of input.transitions)
        await client.query(
          `INSERT INTO provisional_chain_logs
            (transition_id,stream_id,chain_id,event_id,block_number,block_hash,
             transaction_hash,transaction_index,log_index,transition_kind,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [
            transition.transitionId,
            input.streamId,
            input.chainId.toString(),
            input.eventId.toLowerCase(),
            transition.blockNumber.toString(),
            transition.blockHash.toLowerCase(),
            transition.transactionHash.toLowerCase(),
            transition.transactionIndex,
            transition.logIndex,
            transition.kind,
            canonicalJson(transition),
          ],
        );
      await client.query(
        `INSERT INTO provisional_cursors (stream_id,chain_id,block_number,block_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (stream_id) DO UPDATE SET chain_id=EXCLUDED.chain_id,
           block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,
           updated_at=clock_timestamp()`,
        [input.streamId, input.chainId.toString(), last.blockNumber.toString(), last.blockHash],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyFinalizedBoundary(input: {
    streamId: string;
    blockNumber: bigint;
    blockHash: Hex;
  }): Promise<void> {
    const result = await this.pool.query(
      `WITH provisional AS (
         SELECT transition_id FROM provisional_chain_logs WHERE stream_id=$1 AND block_number=$2
       ), finalized AS (
         SELECT transition_id FROM finalized_chain_logs WHERE stream_id=$1 AND block_number=$2
       ), difference AS (
         (SELECT transition_id FROM provisional EXCEPT SELECT transition_id FROM finalized)
         UNION ALL
         (SELECT transition_id FROM finalized EXCEPT SELECT transition_id FROM provisional)
       )
       SELECT b.block_hash,(SELECT COUNT(*) FROM difference)::integer AS difference_count,
              (SELECT COUNT(*) FROM provisional)::integer AS transition_count
       FROM provisional_blocks b WHERE b.stream_id=$1 AND b.block_number=$2`,
      [input.streamId, input.blockNumber.toString()],
    );
    const row = result.rows[0];
    if (!row) return;
    if (String(row.block_hash).toLowerCase() !== input.blockHash.toLowerCase())
      throw new Error("Provisional boundary hash disagrees with finalized history");
    if (Number(row.difference_count) !== 0)
      throw new Error("Provisional transitions disagree with finalized history");
    await this.pool.query(
      `INSERT INTO provisional_promotions
        (stream_id,block_number,block_hash,transition_count,status,verified_at)
       VALUES ($1,$2,$3,$4,'VERIFIED',clock_timestamp())
       ON CONFLICT (stream_id,block_number) DO UPDATE SET
         block_hash=EXCLUDED.block_hash,transition_count=EXCLUDED.transition_count,
         status='VERIFIED',verified_at=clock_timestamp()`,
      [input.streamId, input.blockNumber.toString(), input.blockHash, row.transition_count],
    );
  }

  async commitFinalizedBatch(batch: FinalizedBatch): Promise<void> {
    if (batch.fromBlock > batch.toBlock) throw new Error("Invalid finalized batch range");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cursorResult = await client.query(
        "SELECT chain_id,deployment_block,block_number FROM indexer_cursors WHERE stream_id=$1 FOR UPDATE",
        [batch.streamId],
      );
      const cursor = cursorResult.rows[0];
      if (cursor) {
        if (
          BigInt(cursor.chain_id) !== batch.chainId ||
          BigInt(cursor.deployment_block) !== batch.deploymentBlock ||
          BigInt(cursor.block_number) + 1n !== batch.fromBlock
        )
          throw new Error("Finalized batch does not extend the stored cursor");
      } else if (batch.fromBlock !== batch.deploymentBlock) {
        throw new Error("First finalized batch does not start at deployment");
      }

      await client.query(
        `INSERT INTO projection_totals (stream_id) VALUES ($1)
         ON CONFLICT (stream_id) DO NOTHING`,
        [batch.streamId],
      );
      for (const transition of batch.transitions) {
        const inserted = await client.query(
          `INSERT INTO finalized_chain_logs
            (transition_id,stream_id,chain_id,event_id,contract_address,block_number,block_hash,
             transaction_hash,transaction_index,log_index,transition_kind,payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
           ON CONFLICT (transition_id) DO NOTHING RETURNING transition_id`,
          [
            transition.transitionId,
            batch.streamId,
            transition.chainId.toString(),
            transition.eventId.toLowerCase(),
            transition.address.toLowerCase(),
            transition.blockNumber.toString(),
            transition.blockHash.toLowerCase(),
            transition.transactionHash.toLowerCase(),
            transition.transactionIndex,
            transition.logIndex,
            transition.kind,
            canonicalJson(transition),
          ],
        );
        if (inserted.rowCount === 0) continue;
        await this.#applyProjection(client, batch.streamId, transition);
        await this.#writeJournal(client, batch.streamId, transition);
        await client.query(
          `INSERT INTO transition_outbox (transition_id,stream_id,event_type,payload)
           VALUES ($1,$2,$3,$4::jsonb)`,
          [transition.transitionId, batch.streamId, transition.kind, canonicalJson(transition)],
        );
      }

      if (cursor) {
        await requireOne(
          client.query(
            `UPDATE indexer_cursors SET block_number=$2,block_hash=$3,updated_at=clock_timestamp()
             WHERE stream_id=$1`,
            [batch.streamId, batch.toBlock.toString(), batch.endBlockHash.toLowerCase()],
          ),
          "Failed to advance finalized cursor",
        );
      } else {
        await requireOne(
          client.query(
            `INSERT INTO indexer_cursors
              (stream_id,chain_id,deployment_block,block_number,block_hash)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              batch.streamId,
              batch.chainId.toString(),
              batch.deploymentBlock.toString(),
              batch.toBlock.toString(),
              batch.endBlockHash.toLowerCase(),
            ],
          ),
          "Failed to create finalized cursor",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #applyProjection(
    client: PoolClient,
    streamId: string,
    transition: IndexedTransition,
  ): Promise<void> {
    switch (transition.kind) {
      case "PAYMENT_COMMITTED": {
        if (transition.organizerFeeUnits + transition.platformFeeUnits > transition.grossUnits)
          throw new Error("Payment event has invalid fee allocation");
        await requireOne(
          client.query(
            `INSERT INTO payment_projections
              (stream_id,payment_id,mode,payer,vendor_id,gross_units,organizer_fee_units,
               platform_fee_units,allocation_status,transition_id,transaction_hash,block_number)
             SELECT $1,$2,'ONLINE',$3,$4,$5,$6,$7,'EVENT_VERIFIED',$8,$9,$10
             WHERE NOT EXISTS (
               SELECT 1 FROM payment_cancellations WHERE stream_id=$1 AND payment_id=$2
             )`,
            [
              streamId,
              transition.paymentId.toLowerCase(),
              transition.payer.toLowerCase(),
              transition.vendorId.toLowerCase(),
              transition.grossUnits.toString(),
              transition.organizerFeeUnits.toString(),
              transition.platformFeeUnits.toString(),
              transition.transitionId,
              transition.transactionHash.toLowerCase(),
              transition.blockNumber.toString(),
            ],
          ),
          "Conflicting payment projection",
        );
        await this.#adjustTotals(client, streamId, transition.grossUnits, 0n);
        return;
      }
      case "PAYMENT_CANCELLED":
        await requireOne(
          client.query(
            `INSERT INTO payment_cancellations
              (stream_id,payment_id,payer,transition_id,transaction_hash,block_number)
             SELECT $1,$2,$3,$4,$5,$6
             WHERE NOT EXISTS (
               SELECT 1 FROM payment_projections WHERE stream_id=$1 AND payment_id=$2
             )`,
            [
              streamId,
              transition.paymentId.toLowerCase(),
              transition.payer.toLowerCase(),
              transition.transitionId,
              transition.transactionHash.toLowerCase(),
              transition.blockNumber.toString(),
            ],
          ),
          "Conflicting payment cancellation projection",
        );
        return;
      case "CHANNEL_OPENED":
        await requireOne(
          client.query(
            `INSERT INTO channel_projections
              (stream_id,channel_id,original_account,vendor_id,terminal_instance_id,reserve_units,
               accept_until,submit_until,opened_transition_id,last_transition_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
            [
              streamId,
              transition.channelId.toLowerCase(),
              transition.originalAccount.toLowerCase(),
              transition.vendorId.toLowerCase(),
              transition.terminalInstanceId.toLowerCase(),
              transition.reserveUnits.toString(),
              transition.acceptUntil,
              transition.submitUntil,
              transition.transitionId,
            ],
          ),
          "Conflicting channel projection",
        );
        await this.#adjustTotals(client, streamId, 0n, transition.reserveUnits);
        return;
      case "VOUCHER_SETTLED": {
        await requireOne(
          client.query(
            `UPDATE channel_projections SET
               spent_units=$4,next_sequence=$3+1,last_transition_id=$5
             WHERE stream_id=$1 AND channel_id=$2 AND next_sequence=$3
               AND spent_units+$6=$4 AND reclaimed=false`,
            [
              streamId,
              transition.channelId.toLowerCase(),
              transition.sequence,
              transition.cumulativeGrossUnits.toString(),
              transition.transitionId,
              transition.grossUnits.toString(),
            ],
          ),
          "Voucher does not extend the projected channel",
        );
        await requireOne(
          client.query(
            `INSERT INTO voucher_projections
              (stream_id,channel_id,sequence,payment_id,gross_units,cumulative_gross_units,
               voucher_digest,transition_id,transaction_hash,block_number)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              streamId,
              transition.channelId.toLowerCase(),
              transition.sequence,
              transition.paymentId.toLowerCase(),
              transition.grossUnits.toString(),
              transition.cumulativeGrossUnits.toString(),
              transition.voucherDigest.toLowerCase(),
              transition.transitionId,
              transition.transactionHash.toLowerCase(),
              transition.blockNumber.toString(),
            ],
          ),
          "Conflicting voucher projection",
        );
        await requireOne(
          client.query(
            `INSERT INTO payment_projections
              (stream_id,payment_id,mode,payer,vendor_id,channel_id,gross_units,allocation_status,
               transition_id,transaction_hash,block_number)
             SELECT $1,$2,'OFFLINE',original_account,vendor_id,$3,$4,'READBACK_REQUIRED',$5,$6,$7
             FROM channel_projections WHERE stream_id=$1 AND channel_id=$3`,
            [
              streamId,
              transition.paymentId.toLowerCase(),
              transition.channelId.toLowerCase(),
              transition.grossUnits.toString(),
              transition.transitionId,
              transition.transactionHash.toLowerCase(),
              transition.blockNumber.toString(),
            ],
          ),
          "Voucher channel is missing",
        );
        await this.#adjustTotals(client, streamId, transition.grossUnits, -transition.grossUnits);
        return;
      }
      case "CHANNEL_RECLAIMED":
        await requireOne(
          client.query(
            `UPDATE channel_projections SET returned_units=$3,reclaimed=true,last_transition_id=$4
             WHERE stream_id=$1 AND channel_id=$2 AND original_account=$5 AND reclaimed=false
               AND reserve_units-spent_units=$3`,
            [
              streamId,
              transition.channelId.toLowerCase(),
              transition.returnedUnits.toString(),
              transition.transitionId,
              transition.originalAccount.toLowerCase(),
            ],
          ),
          "Reclaim does not match the projected channel",
        );
        await this.#adjustTotals(client, streamId, 0n, -transition.returnedUnits);
        return;
      case "REFUND_COMMITTED":
        await requireOne(
          client.query(
            `INSERT INTO refund_projections
              (stream_id,refund_id,payment_id,payer,amount_units,vendor_credit_units,
               transition_id,transaction_hash,block_number)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
             FROM payment_projections
             WHERE stream_id=$1 AND payment_id=$3 AND payer=$4`,
            [
              streamId,
              transition.refundId.toLowerCase(),
              transition.paymentId.toLowerCase(),
              transition.payer.toLowerCase(),
              transition.amountUnits.toString(),
              transition.vendorCreditUnits.toString(),
              transition.transitionId,
              transition.transactionHash.toLowerCase(),
              transition.blockNumber.toString(),
            ],
          ),
          "Conflicting refund projection",
        );
        await this.#adjustTotals(client, streamId, -transition.vendorCreditUnits, 0n);
        return;
      case "WITHDRAWN":
        await requireOne(
          client.query(
            `INSERT INTO withdrawal_projections
              (stream_id,transition_id,beneficiary_id,destination,amount_units,transaction_hash,block_number)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              streamId,
              transition.transitionId,
              transition.beneficiaryId.toLowerCase(),
              transition.destination.toLowerCase(),
              transition.amountUnits.toString(),
              transition.transactionHash.toLowerCase(),
              transition.blockNumber.toString(),
            ],
          ),
          "Conflicting withdrawal projection",
        );
        await this.#adjustTotals(client, streamId, -transition.amountUnits, 0n);
        return;
    }
  }

  async #adjustTotals(
    client: PoolClient,
    streamId: string,
    ledgerDelta: bigint,
    vaultDelta: bigint,
  ) {
    await requireOne(
      client.query(
        `UPDATE projection_totals SET
           ledger_liability_units=ledger_liability_units+$2,
           vault_reserved_units=vault_reserved_units+$3,
           updated_at=clock_timestamp()
         WHERE stream_id=$1`,
        [streamId, ledgerDelta.toString(), vaultDelta.toString()],
      ),
      "Failed to update projection totals",
    );
  }

  async #writeJournal(client: PoolClient, streamId: string, transition: IndexedTransition) {
    const lines = journalLines(transition).filter((line) => line.units > 0n);
    if (lines.length === 0) return;
    const debit = lines
      .filter((line) => line.side === "DEBIT")
      .reduce((total, line) => total + line.units, 0n);
    const credit = lines
      .filter((line) => line.side === "CREDIT")
      .reduce((total, line) => total + line.units, 0n);
    if (debit !== credit) throw new Error("Unbalanced projected journal transition");
    await client.query(
      `INSERT INTO balanced_journal_batches (transition_id,stream_id,debit_units,credit_units)
       VALUES ($1,$2,$3,$4)`,
      [transition.transitionId, streamId, debit.toString(), credit.toString()],
    );
    for (const [index, line] of lines.entries())
      await client.query(
        `INSERT INTO balanced_journal_entries
          (transition_id,line_number,account_key,side,units) VALUES ($1,$2,$3,$4,$5)`,
        [transition.transitionId, index + 1, line.account, line.side, line.units.toString()],
      );
  }

  async getExpectedConservation(
    streamId: string,
  ): Promise<{ cursor: IndexerCursor; snapshot: ConservationSnapshot } | null> {
    const result = await this.pool.query(
      `SELECT c.block_number,c.block_hash,t.ledger_liability_units,t.vault_reserved_units
       FROM indexer_cursors c JOIN projection_totals t USING (stream_id)
       WHERE c.stream_id=$1`,
      [streamId],
    );
    const row = result.rows[0];
    return row
      ? {
          cursor: { blockNumber: BigInt(row.block_number), blockHash: row.block_hash as Hex },
          snapshot: {
            ledgerLiabilityUnits: BigInt(row.ledger_liability_units),
            vaultReservedUnits: BigInt(row.vault_reserved_units),
          },
        }
      : null;
  }

  async recordReconciliation(result: ReconciliationResult, streamId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO reconciliation_runs
          (run_id,stream_id,block_number,block_hash,expected_ledger_liability,
           actual_ledger_liability,expected_vault_reserved,actual_vault_reserved,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (run_id) DO NOTHING`,
        [
          result.runId,
          streamId,
          result.blockNumber.toString(),
          result.blockHash.toLowerCase(),
          result.expected.ledgerLiabilityUnits.toString(),
          result.actual.ledgerLiabilityUnits.toString(),
          result.expected.vaultReservedUnits.toString(),
          result.actual.vaultReservedUnits.toString(),
          result.differences.length === 0 ? "MATCHED" : "DIFFERENT",
        ],
      );
      for (const metric of result.differences) {
        const ledger = metric === "LEDGER_LIABILITY";
        await client.query(
          `INSERT INTO reconciliation_differences (run_id,metric,expected_units,actual_units)
           VALUES ($1,$2,$3,$4) ON CONFLICT (run_id,metric) DO NOTHING`,
          [
            result.runId,
            metric,
            (ledger
              ? result.expected.ledgerLiabilityUnits
              : result.expected.vaultReservedUnits
            ).toString(),
            (ledger
              ? result.actual.ledgerLiabilityUnits
              : result.actual.vaultReservedUnits
            ).toString(),
          ],
        );
      }
      if (result.differences.length > 0)
        await writeIncident(client, {
          streamId,
          code: "CONSERVATION_MISMATCH",
          blockNumber: result.blockNumber,
          expectedBlockHash: result.blockHash,
          observedBlockHash: result.blockHash,
          message: `Projected custody differs from finalized contracts: ${result.differences.join(",")}`,
        });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  recordIntegrityIncident(incident: IntegrityIncidentInput): Promise<void> {
    return writeIncident(this.pool, incident).then(() => undefined);
  }
}
