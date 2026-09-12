import type { Pool, PoolClient } from "pg";
import type { Address, Hex } from "viem";

export class ProjectionNotFound extends Error {}

type ActivityCursor = {
  blockNumber: bigint;
  transitionId: string;
};

type Queryable = Pick<PoolClient, "query">;

const lower = (value: string) => value.toLowerCase();

function paymentStatus(grossUnits: bigint, refundedUnits: bigint) {
  if (refundedUnits === 0n) return "FINALIZED" as const;
  if (refundedUnits < grossUnits) return "PARTIALLY_REFUNDED" as const;
  if (refundedUnits === grossUnits) return "REFUNDED" as const;
  throw new Error("Projected refunds exceed payment gross");
}

async function inSnapshot<T>(pool: Pool, operation: (db: Queryable) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export class OperationalReadService {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      `SELECT to_regclass('public.payment_projections') AS payments,
              to_regclass('public.channel_projections') AS channels,
              to_regclass('public.indexer_cursors') AS cursors`,
    );
    if (!result.rows[0]?.payments || !result.rows[0]?.channels || !result.rows[0]?.cursors)
      throw new Error("Finalized projection database migration is not installed");
  }

  async payment(account: Address, paymentId: Hex) {
    return inSnapshot(this.pool, async (db) => {
      const committed = await db.query(
        `SELECT p.stream_id,p.payment_id,p.mode,p.vendor_id,p.channel_id,p.gross_units,
                p.organizer_fee_units,p.platform_fee_units,p.allocation_status,p.transaction_hash,
                p.block_number,l.block_hash AS transaction_block_hash,
                c.block_number AS finalized_block,c.block_hash AS finalized_block_hash,
                COALESCE(SUM(r.amount_units),0) AS refunded_units,
                COUNT(r.refund_id)::integer AS refund_count
         FROM payment_projections p
         JOIN finalized_chain_logs l ON l.transition_id=p.transition_id
         JOIN indexer_cursors c ON c.stream_id=p.stream_id
         LEFT JOIN refund_projections r
           ON r.stream_id=p.stream_id AND r.payment_id=p.payment_id
         WHERE p.payment_id=$1 AND p.payer=$2
         GROUP BY p.stream_id,p.payment_id,p.mode,p.vendor_id,p.channel_id,p.gross_units,
                  p.organizer_fee_units,p.platform_fee_units,p.allocation_status,p.transaction_hash,
                  p.block_number,l.block_hash,c.block_number,c.block_hash`,
        [lower(paymentId), lower(account)],
      );
      if (committed.rowCount === 1) {
        const row = committed.rows[0];
        const grossUnits = BigInt(row.gross_units);
        const refundedUnits = BigInt(row.refunded_units);
        return {
          paymentId: row.payment_id as Hex,
          status: paymentStatus(grossUnits, refundedUnits),
          mode: row.mode as "ONLINE" | "OFFLINE",
          vendorId: row.vendor_id as Hex,
          channelId: (row.channel_id as Hex | null) ?? null,
          grossUnits: grossUnits.toString(),
          organizerFeeUnits: row.organizer_fee_units?.toString() ?? null,
          platformFeeUnits: row.platform_fee_units?.toString() ?? null,
          refundedUnits: refundedUnits.toString(),
          refundCount: Number(row.refund_count),
          allocationStatus: row.allocation_status as "EVENT_VERIFIED" | "READBACK_REQUIRED",
          proof: {
            transactionHash: row.transaction_hash as Hex,
            blockNumber: row.block_number.toString(),
            blockHash: row.transaction_block_hash as Hex,
            finalizedThroughBlock: row.finalized_block.toString(),
            finalizedThroughBlockHash: row.finalized_block_hash as Hex,
          },
        };
      }
      if ((committed.rowCount ?? 0) > 1)
        throw new Error("Payment identifier is ambiguous across projection streams");

      const cancelled = await db.query(
        `SELECT x.payment_id,x.transaction_hash,x.block_number,l.block_hash AS transaction_block_hash,
                c.block_number AS finalized_block,c.block_hash AS finalized_block_hash
         FROM payment_cancellations x
         JOIN finalized_chain_logs l ON l.transition_id=x.transition_id
         JOIN indexer_cursors c ON c.stream_id=x.stream_id
         WHERE x.payment_id=$1 AND x.payer=$2`,
        [lower(paymentId), lower(account)],
      );
      if (cancelled.rowCount !== 1) {
        if ((cancelled.rowCount ?? 0) > 1)
          throw new Error("Payment identifier is ambiguous across projection streams");
        throw new ProjectionNotFound();
      }
      const row = cancelled.rows[0];
      return {
        paymentId: row.payment_id as Hex,
        status: "CANCELLED" as const,
        mode: null,
        vendorId: null,
        channelId: null,
        grossUnits: null,
        organizerFeeUnits: null,
        platformFeeUnits: null,
        refundedUnits: "0",
        refundCount: 0,
        allocationStatus: null,
        proof: {
          transactionHash: row.transaction_hash as Hex,
          blockNumber: row.block_number.toString(),
          blockHash: row.transaction_block_hash as Hex,
          finalizedThroughBlock: row.finalized_block.toString(),
          finalizedThroughBlockHash: row.finalized_block_hash as Hex,
        },
      };
    });
  }

  async channel(account: Address, channelId: Hex) {
    const result = await this.pool.query(
      `SELECT ch.channel_id,ch.vendor_id,ch.terminal_instance_id,ch.reserve_units,ch.spent_units,
              ch.returned_units,ch.next_sequence,ch.accept_until,ch.submit_until,ch.reclaimed,
              l.transaction_hash,l.block_number,l.block_hash AS transaction_block_hash,
              c.block_number AS finalized_block,c.block_hash AS finalized_block_hash,
              COUNT(v.sequence)::integer AS voucher_count,
              MAX(v.block_number) AS latest_voucher_block
       FROM channel_projections ch
       JOIN finalized_chain_logs l ON l.transition_id=ch.last_transition_id
       JOIN indexer_cursors c ON c.stream_id=ch.stream_id
       LEFT JOIN voucher_projections v
         ON v.stream_id=ch.stream_id AND v.channel_id=ch.channel_id
       WHERE ch.channel_id=$1 AND ch.original_account=$2
       GROUP BY ch.channel_id,ch.vendor_id,ch.terminal_instance_id,ch.reserve_units,ch.spent_units,
                ch.returned_units,ch.next_sequence,ch.accept_until,ch.submit_until,ch.reclaimed,
                l.transaction_hash,l.block_number,l.block_hash,c.block_number,c.block_hash`,
      [lower(channelId), lower(account)],
    );
    if (result.rowCount !== 1) {
      if ((result.rowCount ?? 0) > 1)
        throw new Error("Channel identifier is ambiguous across projection streams");
      throw new ProjectionNotFound();
    }
    const row = result.rows[0];
    const reserveUnits = BigInt(row.reserve_units);
    const spentUnits = BigInt(row.spent_units);
    const returnedUnits = BigInt(row.returned_units);
    return {
      channelId: row.channel_id as Hex,
      status: row.reclaimed ? ("RECLAIMED" as const) : ("ACTIVE" as const),
      vendorId: row.vendor_id as Hex,
      terminalInstanceId: row.terminal_instance_id as Hex,
      reserveUnits: reserveUnits.toString(),
      spentUnits: spentUnits.toString(),
      returnedUnits: returnedUnits.toString(),
      remainingUnits: (reserveUnits - spentUnits - returnedUnits).toString(),
      nextSequence: row.next_sequence.toString(),
      voucherCount: Number(row.voucher_count),
      acceptUntil: row.accept_until.toString(),
      submitUntil: row.submit_until.toString(),
      latestVoucherBlock: row.latest_voucher_block?.toString() ?? null,
      proof: {
        transactionHash: row.transaction_hash as Hex,
        blockNumber: row.block_number.toString(),
        blockHash: row.transaction_block_hash as Hex,
        finalizedThroughBlock: row.finalized_block.toString(),
        finalizedThroughBlockHash: row.finalized_block_hash as Hex,
      },
    };
  }

  async activity(account: Address, limit: number, cursor?: ActivityCursor) {
    const result = await this.pool.query(
      `WITH owned_transitions AS (
         SELECT p.transition_id,p.block_number,p.payment_id AS aggregate_id,
                'PAYMENT'::text AS aggregate_kind
         FROM payment_projections p WHERE p.payer=$1
         UNION ALL
         SELECT x.transition_id,x.block_number,x.payment_id,'PAYMENT'
         FROM payment_cancellations x WHERE x.payer=$1
         UNION ALL
         SELECT ch.opened_transition_id,l.block_number,ch.channel_id,'CHANNEL'
         FROM channel_projections ch
         JOIN finalized_chain_logs l ON l.transition_id=ch.opened_transition_id
         WHERE ch.original_account=$1
         UNION ALL
         SELECT ch.last_transition_id,l.block_number,ch.channel_id,'CHANNEL'
         FROM channel_projections ch
         JOIN finalized_chain_logs l ON l.transition_id=ch.last_transition_id
         WHERE ch.original_account=$1 AND ch.reclaimed=true
         UNION ALL
         SELECT r.transition_id,r.block_number,r.payment_id,'PAYMENT'
         FROM refund_projections r WHERE r.payer=$1
       )
       SELECT o.transition_id,o.block_number,o.aggregate_id,o.aggregate_kind,
              l.transition_kind,l.transaction_hash,l.block_hash
       FROM owned_transitions o
       JOIN finalized_chain_logs l ON l.transition_id=o.transition_id
       WHERE ($2::bigint IS NULL OR (o.block_number,o.transition_id) < ($2,$3))
       ORDER BY o.block_number DESC,o.transition_id DESC
       LIMIT $4`,
      [
        lower(account),
        cursor?.blockNumber.toString() ?? null,
        cursor?.transitionId ?? null,
        limit + 1,
      ],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        transitionId: row.transition_id as string,
        kind: row.transition_kind as string,
        aggregateKind: row.aggregate_kind as "PAYMENT" | "CHANNEL",
        aggregateId: row.aggregate_id as Hex,
        transactionHash: row.transaction_hash as Hex,
        blockNumber: row.block_number.toString(),
        blockHash: row.block_hash as Hex,
      })),
      nextCursor:
        hasMore && last
          ? {
              blockNumber: last.block_number.toString(),
              transitionId: last.transition_id as string,
            }
          : null,
    };
  }
}
