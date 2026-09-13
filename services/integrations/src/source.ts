import type { Pool } from "pg";
import { getAddress, type Hex } from "viem";
import type { FinalizedPaymentWrite } from "./erpnext.js";
import type { IntegrationJobJournal } from "./journal.js";

export type IntegrationMapping = {
  streamId: string;
  eventId: Hex;
  vendorId: Hex;
  company: string;
  assetCode: string;
};

type Cursor = {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  transitionId: string;
};

export class IntegrationMappingRequired extends Error {}

export class FinalizedPaymentImporter {
  constructor(
    private readonly indexer: Pool,
    private readonly api: Pool,
    private readonly state: Pool,
    private readonly journal: IntegrationJobJournal,
    private readonly mappings: readonly IntegrationMapping[],
  ) {
    const keys = mappings.map(
      (item) => `${item.streamId}:${item.eventId.toLowerCase()}:${item.vendorId.toLowerCase()}`,
    );
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate integration mapping");
  }

  async importOnce(streamId: string, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Invalid integration import limit");
    const cursor = await this.#cursor(streamId);
    const result = await this.indexer.query(
      `SELECT l.transition_id,l.chain_id,l.event_id,l.block_number,l.block_hash,
              l.transaction_hash,l.transaction_index,l.log_index,
              p.payment_id,p.payer,p.vendor_id,p.gross_units
       FROM payment_projections p JOIN finalized_chain_logs l ON l.transition_id=p.transition_id
       WHERE p.stream_id=$1 AND p.mode='ONLINE'
         AND ($2::bigint IS NULL OR (l.block_number,l.transaction_index,l.log_index,l.transition_id) > ($2,$3,$4,$5))
       ORDER BY l.block_number,l.transaction_index,l.log_index,l.transition_id LIMIT $6`,
      [
        streamId,
        cursor?.blockNumber.toString() ?? null,
        cursor?.transactionIndex ?? null,
        cursor?.logIndex ?? null,
        cursor?.transitionId ?? null,
        limit,
      ],
    );
    let imported = 0;
    for (const row of result.rows) {
      const mapping = this.mappings.find(
        (candidate) =>
          candidate.streamId === streamId &&
          candidate.eventId.toLowerCase() === String(row.event_id).toLowerCase() &&
          candidate.vendorId.toLowerCase() === String(row.vendor_id).toLowerCase(),
      );
      if (!mapping)
        throw new IntegrationMappingRequired("Finalized payment has no approved partner mapping");
      const checkout = await this.api.query(
        `SELECT order_reference FROM checkout_orders
         WHERE payment_id=$1 AND stream_id=$2 AND event_id=$3 AND vendor_id=$4 AND state='READY'`,
        [row.payment_id, streamId, row.event_id, row.vendor_id],
      );
      if (checkout.rowCount !== 1)
        throw new IntegrationMappingRequired(
          "Finalized payment has no unique ready checkout order",
        );
      const payment: FinalizedPaymentWrite = {
        transitionId: row.transition_id,
        company: mapping.company,
        orderReference: checkout.rows[0].order_reference,
        paymentId: row.payment_id as Hex,
        payer: getAddress(row.payer),
        amountUnits: BigInt(row.gross_units),
        assetCode: mapping.assetCode,
        chainId: BigInt(row.chain_id),
        transactionHash: row.transaction_hash as Hex,
        blockNumber: BigInt(row.block_number),
        blockHash: row.block_hash as Hex,
      };
      await this.journal.enqueue(payment);
      await this.#advance(streamId, {
        blockNumber: payment.blockNumber,
        transactionIndex: Number(row.transaction_index),
        logIndex: Number(row.log_index),
        transitionId: payment.transitionId,
      });
      imported += 1;
    }
    return imported;
  }

  async #cursor(streamId: string): Promise<Cursor | null> {
    const result = await this.state.query(
      `SELECT block_number,transaction_index,log_index,transition_id
       FROM integration_source_cursors WHERE stream_id=$1`,
      [streamId],
    );
    const row = result.rows[0];
    return row
      ? {
          blockNumber: BigInt(row.block_number),
          transactionIndex: Number(row.transaction_index),
          logIndex: Number(row.log_index),
          transitionId: row.transition_id,
        }
      : null;
  }

  async #advance(streamId: string, cursor: Cursor): Promise<void> {
    await this.state.query(
      `INSERT INTO integration_source_cursors
        (stream_id,block_number,transaction_index,log_index,transition_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (stream_id) DO UPDATE SET block_number=EXCLUDED.block_number,
         transaction_index=EXCLUDED.transaction_index,log_index=EXCLUDED.log_index,
         transition_id=EXCLUDED.transition_id,updated_at=clock_timestamp()
       WHERE (integration_source_cursors.block_number,integration_source_cursors.transaction_index,
              integration_source_cursors.log_index,integration_source_cursors.transition_id)
             < (EXCLUDED.block_number,EXCLUDED.transaction_index,EXCLUDED.log_index,EXCLUDED.transition_id)`,
      [
        streamId,
        cursor.blockNumber.toString(),
        cursor.transactionIndex,
        cursor.logIndex,
        cursor.transitionId,
      ],
    );
  }
}
