import type { Pool, PoolClient } from "pg";
import type { Hex } from "viem";
import { ProjectionNotFound } from "./operations.js";
import type { OperationsIdentity } from "./operations-access.js";

type Queryable = Pick<PoolClient, "query">;

async function snapshot<T>(pool: Pool, operation: (db: Queryable) => Promise<T>): Promise<T> {
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

async function requireScope(db: Queryable, identity: OperationsIdentity) {
  const result = await db.query(
    `SELECT c.block_number,c.block_hash,c.updated_at
     FROM indexer_cursors c
     WHERE c.stream_id=$1 AND EXISTS (
       SELECT 1 FROM finalized_chain_logs l
       WHERE l.stream_id=c.stream_id AND l.event_id=$2
     )`,
    [identity.streamId, identity.eventId.toLowerCase()],
  );
  if (result.rowCount !== 1) throw new ProjectionNotFound();
  return result.rows[0];
}

export class OperationsReportingService {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      `SELECT to_regclass('public.reconciliation_runs') AS reconciliation,
              to_regclass('public.operations_vendor_beneficiaries') AS beneficiaries,
              to_regclass('public.operational_incidents') AS incidents`,
    );
    if (
      !result.rows[0]?.reconciliation ||
      !result.rows[0]?.beneficiaries ||
      !result.rows[0]?.incidents
    )
      throw new Error("Operational reporting migrations are not installed");
  }

  statement(
    identity: OperationsIdentity,
    vendorId: Hex,
    options: {
      fromBlock?: bigint;
      toBlock?: bigint;
      limit: number;
      afterBlock?: bigint;
      afterPaymentId?: Hex;
    },
  ) {
    return snapshot(this.pool, async (db) => {
      const cursor = await requireScope(db, identity);
      const toBlock = options.toBlock ?? BigInt(cursor.block_number);
      const fromBlock = options.fromBlock ?? 0n;
      if (fromBlock > toBlock || toBlock > BigInt(cursor.block_number))
        throw new RangeError("Statement range is outside finalized history");

      const paymentTotals = await db.query(
        `WITH refund_totals AS (
           SELECT stream_id,payment_id,SUM(amount_units) AS refunded_units,
                  SUM(vendor_credit_units) AS vendor_credit_refund_units
           FROM refund_projections WHERE stream_id=$1 GROUP BY stream_id,payment_id
         )
         SELECT COUNT(*)::integer AS payment_count,
                COALESCE(SUM(p.gross_units),0) AS gross_units,
                COALESCE(SUM(COALESCE(r.refunded_units,0)),0) AS refunded_units,
                COALESCE(SUM(COALESCE(r.vendor_credit_refund_units,0)),0) AS vendor_credit_refund_units,
                COALESCE(SUM(CASE WHEN p.allocation_status='EVENT_VERIFIED'
                  THEN p.organizer_fee_units ELSE 0 END),0) AS organizer_fee_units,
                COALESCE(SUM(CASE WHEN p.allocation_status='EVENT_VERIFIED'
                  THEN p.platform_fee_units ELSE 0 END),0) AS platform_fee_units,
                COALESCE(SUM(CASE WHEN p.allocation_status='EVENT_VERIFIED'
                  THEN p.gross_units-p.organizer_fee_units-p.platform_fee_units ELSE 0 END),0)
                  AS verified_vendor_net_units,
                COALESCE(SUM(CASE WHEN p.allocation_status='READBACK_REQUIRED'
                  THEN p.gross_units ELSE 0 END),0) AS readback_required_gross_units
         FROM payment_projections p
         LEFT JOIN refund_totals r USING (stream_id,payment_id)
         WHERE p.stream_id=$1 AND p.vendor_id=$2 AND p.block_number BETWEEN $3 AND $4`,
        [identity.streamId, vendorId.toLowerCase(), fromBlock.toString(), toBlock.toString()],
      );
      const payments = await db.query(
        `SELECT p.payment_id,p.mode,p.gross_units,p.organizer_fee_units,p.platform_fee_units,
                p.allocation_status,p.transaction_hash,p.block_number,l.block_hash,
                COALESCE(SUM(r.amount_units),0) AS refunded_units,
                COALESCE(SUM(r.vendor_credit_units),0) AS vendor_credit_refund_units
         FROM payment_projections p
         JOIN finalized_chain_logs l ON l.transition_id=p.transition_id
         LEFT JOIN refund_projections r
           ON r.stream_id=p.stream_id AND r.payment_id=p.payment_id
         WHERE p.stream_id=$1 AND p.vendor_id=$2 AND p.block_number BETWEEN $3 AND $4
           AND ($5::bigint IS NULL OR (p.block_number,p.payment_id) > ($5,$6))
         GROUP BY p.payment_id,p.mode,p.gross_units,p.organizer_fee_units,p.platform_fee_units,
                  p.allocation_status,p.transaction_hash,p.block_number,l.block_hash
         ORDER BY p.block_number,p.payment_id LIMIT $7`,
        [
          identity.streamId,
          vendorId.toLowerCase(),
          fromBlock.toString(),
          toBlock.toString(),
          options.afterBlock?.toString() ?? null,
          options.afterPaymentId?.toLowerCase() ?? null,
          options.limit + 1,
        ],
      );
      const mappings = await db.query(
        `SELECT beneficiary_id,destination,approved_reference,valid_from_block,valid_to_block
         FROM operations_vendor_beneficiaries
         WHERE stream_id=$1 AND event_id=$2 AND vendor_id=$3
           AND valid_from_block <= $5 AND (valid_to_block IS NULL OR valid_to_block >= $4)
         ORDER BY valid_from_block,beneficiary_id LIMIT 101`,
        [
          identity.streamId,
          identity.eventId.toLowerCase(),
          vendorId.toLowerCase(),
          fromBlock.toString(),
          toBlock.toString(),
        ],
      );
      if (mappings.rows.length > 100)
        throw new Error("Vendor beneficiary mapping count exceeds the supported bound");
      const beneficiaryIds = mappings.rows.map((row) => row.beneficiary_id as string);
      const withdrawalTotals =
        beneficiaryIds.length === 0
          ? { rows: [{ amount_units: "0", withdrawal_count: 0 }] }
          : await db.query(
              `SELECT COALESCE(SUM(amount_units),0) AS amount_units,COUNT(*)::integer AS withdrawal_count
               FROM withdrawal_projections WHERE stream_id=$1 AND beneficiary_id=ANY($2::text[])
                 AND block_number BETWEEN $3 AND $4`,
              [identity.streamId, beneficiaryIds, fromBlock.toString(), toBlock.toString()],
            );
      const withdrawals =
        beneficiaryIds.length === 0
          ? { rows: [] as Record<string, unknown>[] }
          : await db.query(
              `SELECT w.transition_id,w.beneficiary_id,w.destination,w.amount_units,
                      w.transaction_hash,w.block_number,l.block_hash
               FROM withdrawal_projections w
               JOIN finalized_chain_logs l ON l.transition_id=w.transition_id
               WHERE w.stream_id=$1 AND w.beneficiary_id=ANY($2::text[])
                 AND w.block_number BETWEEN $3 AND $4
               ORDER BY w.block_number DESC,w.transition_id DESC LIMIT 101`,
              [identity.streamId, beneficiaryIds, fromBlock.toString(), toBlock.toString()],
            );

      const totals = paymentTotals.rows[0];
      const verifiedVendorNet = BigInt(totals.verified_vendor_net_units);
      const vendorCreditRefunds = BigInt(totals.vendor_credit_refund_units);
      const withdrawn = BigInt(withdrawalTotals.rows[0].amount_units);
      const readbackRequiredGross = BigInt(totals.readback_required_gross_units);
      const fullFinalizedHistory = fromBlock === 0n && toBlock === BigInt(cursor.block_number);
      const allocationComplete =
        fullFinalizedHistory && readbackRequiredGross === 0n && mappings.rows.length > 0;
      const availableAllocation = verifiedVendorNet - vendorCreditRefunds - withdrawn;
      if (allocationComplete && availableAllocation < 0n)
        throw new Error("Vendor statement produces a negative finalized allocation");

      return {
        eventId: identity.eventId,
        vendorId,
        range: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString() },
        finalizedThrough: {
          blockNumber: cursor.block_number.toString(),
          blockHash: cursor.block_hash as Hex,
          indexedAt: new Date(cursor.updated_at).toISOString(),
        },
        totals: {
          paymentCount: Number(totals.payment_count),
          grossUnits: totals.gross_units.toString(),
          refundedUnits: totals.refunded_units.toString(),
          vendorCreditRefundUnits: vendorCreditRefunds.toString(),
          organizerFeeUnits: totals.organizer_fee_units.toString(),
          platformFeeUnits: totals.platform_fee_units.toString(),
          verifiedVendorNetUnits: verifiedVendorNet.toString(),
          readbackRequiredGrossUnits: readbackRequiredGross.toString(),
          withdrawnUnits: withdrawn.toString(),
          availableAllocationUnits: allocationComplete ? availableAllocation.toString() : null,
          allocationStatus: allocationComplete
            ? "COMPLETE"
            : fullFinalizedHistory
              ? "READBACK_REQUIRED"
              : "PERIOD_ONLY",
        },
        payments: payments.rows.slice(0, options.limit).map((row) => ({
          paymentId: row.payment_id as Hex,
          mode: row.mode as "ONLINE" | "OFFLINE",
          grossUnits: row.gross_units.toString(),
          organizerFeeUnits: row.organizer_fee_units?.toString() ?? null,
          platformFeeUnits: row.platform_fee_units?.toString() ?? null,
          refundedUnits: row.refunded_units.toString(),
          allocationStatus: row.allocation_status,
          proof: {
            transactionHash: row.transaction_hash as Hex,
            blockNumber: row.block_number.toString(),
            blockHash: row.block_hash as Hex,
          },
        })),
        nextPaymentCursor:
          payments.rows.length > options.limit
            ? {
                blockNumber: payments.rows[options.limit - 1].block_number.toString(),
                paymentId: payments.rows[options.limit - 1].payment_id as Hex,
              }
            : null,
        withdrawals: withdrawals.rows.slice(0, 100).map((row) => ({
          transitionId: row.transition_id,
          beneficiaryId: row.beneficiary_id as Hex,
          destination: row.destination,
          amountUnits: row.amount_units.toString(),
          proof: {
            transactionHash: row.transaction_hash as Hex,
            blockNumber: row.block_number.toString(),
            blockHash: row.block_hash as Hex,
          },
        })),
        withdrawalsTruncated: withdrawals.rows.length > 100,
        withdrawalCount: Number(withdrawalTotals.rows[0].withdrawal_count),
        beneficiaryMappings: mappings.rows.map((row) => ({
          beneficiaryId: row.beneficiary_id as Hex,
          destination: row.destination,
          approvedReference: row.approved_reference,
          validFromBlock: row.valid_from_block.toString(),
          validToBlock: row.valid_to_block?.toString() ?? null,
        })),
      };
    });
  }

  reconciliation(identity: OperationsIdentity) {
    return snapshot(this.pool, async (db) => {
      const cursor = await requireScope(db, identity);
      const latest = await db.query(
        `SELECT run_id,block_number,block_hash,expected_ledger_liability,
                actual_ledger_liability,expected_vault_reserved,actual_vault_reserved,
                status,created_at
         FROM reconciliation_runs WHERE stream_id=$1
         ORDER BY block_number DESC,created_at DESC LIMIT 1`,
        [identity.streamId],
      );
      const differences = latest.rows[0]
        ? await db.query(
            `SELECT metric,expected_units,actual_units
             FROM reconciliation_differences WHERE run_id=$1 ORDER BY metric`,
            [latest.rows[0].run_id],
          )
        : { rows: [] as Record<string, unknown>[] };
      const exposure = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE allocation_status='READBACK_REQUIRED')::integer AS readback_count,
           COALESCE(SUM(gross_units) FILTER (WHERE allocation_status='READBACK_REQUIRED'),0) AS readback_units
         FROM payment_projections WHERE stream_id=$1`,
        [identity.streamId],
      );
      const incidents = await db.query(
        `SELECT incident_id,code,severity,message,created_at
         FROM integrity_incidents WHERE stream_id=$1 AND status='OPEN'
         ORDER BY created_at,incident_id`,
        [identity.streamId],
      );
      const row = latest.rows[0];
      const status = !row
        ? "NOT_RUN"
        : row.status === "DIFFERENT"
          ? "DIFFERENT"
          : BigInt(row.block_number) === BigInt(cursor.block_number) &&
              String(row.block_hash).toLowerCase() === String(cursor.block_hash).toLowerCase()
            ? "MATCHED"
            : "STALE";
      return {
        eventId: identity.eventId,
        status,
        finalizedThrough: {
          blockNumber: cursor.block_number.toString(),
          blockHash: cursor.block_hash as Hex,
          indexedAt: new Date(cursor.updated_at).toISOString(),
        },
        latestRun: row
          ? {
              runId: row.run_id,
              blockNumber: row.block_number.toString(),
              blockHash: row.block_hash as Hex,
              expectedLedgerLiabilityUnits: row.expected_ledger_liability.toString(),
              actualLedgerLiabilityUnits: row.actual_ledger_liability.toString(),
              expectedVaultReservedUnits: row.expected_vault_reserved.toString(),
              actualVaultReservedUnits: row.actual_vault_reserved.toString(),
              createdAt: new Date(row.created_at).toISOString(),
            }
          : null,
        differences: differences.rows.map((difference) => ({
          metric: difference.metric,
          expectedUnits: difference.expected_units.toString(),
          actualUnits: difference.actual_units.toString(),
        })),
        pendingAllocationReadback: {
          paymentCount: Number(exposure.rows[0]?.readback_count ?? 0),
          grossUnits: exposure.rows[0]?.readback_units?.toString() ?? "0",
        },
        openIntegrityIncidents: incidents.rows.map((incident) => ({
          incidentId: incident.incident_id,
          code: incident.code,
          severity: incident.severity,
          message: incident.message,
          createdAt: new Date(incident.created_at).toISOString(),
        })),
      };
    });
  }
}
