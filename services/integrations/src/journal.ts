import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Hex } from "viem";
import type { FinalizedPaymentWrite } from "./erpnext.js";

type StoredPayment = Omit<FinalizedPaymentWrite, "amountUnits" | "chainId" | "blockNumber"> & {
  amountUnits: string;
  chainId: string;
  blockNumber: string;
};

export type IntegrationJob = {
  transitionId: string;
  state: "READY" | "LEASED" | "RETRY" | "COMPLETED" | "QUARANTINED";
  attempts: number;
  leaseToken: string | null;
  payment: FinalizedPaymentWrite;
};

export class IntegrationJobConflict extends Error {}
export class IntegrationLeaseLost extends Error {}

function stored(input: FinalizedPaymentWrite): StoredPayment {
  return {
    ...input,
    amountUnits: input.amountUnits.toString(),
    chainId: input.chainId.toString(),
    blockNumber: input.blockNumber.toString(),
  };
}

function canonical(input: FinalizedPaymentWrite): string {
  const value = stored(input);
  return JSON.stringify({
    ...value,
    paymentId: value.paymentId.toLowerCase(),
    payer: value.payer.toLowerCase(),
    transactionHash: value.transactionHash.toLowerCase(),
    blockHash: value.blockHash.toLowerCase(),
  });
}

function hydrate(row: Record<string, unknown>): IntegrationJob {
  const payload = row.payload as StoredPayment;
  return {
    transitionId: String(row.transition_id),
    state: row.state as IntegrationJob["state"],
    attempts: Number(row.attempts),
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    payment: {
      ...payload,
      paymentId: payload.paymentId as Hex,
      payer: payload.payer as `0x${string}`,
      transactionHash: payload.transactionHash as Hex,
      blockHash: payload.blockHash as Hex,
      amountUnits: BigInt(payload.amountUnits),
      chainId: BigInt(payload.chainId),
      blockNumber: BigInt(payload.blockNumber),
    },
  };
}

export class IntegrationJobJournal {
  constructor(private readonly pool: Pool) {}

  async assertReady() {
    const result = await this.pool.query(
      "SELECT to_regclass('public.integration_jobs') AS jobs,to_regclass('public.integration_attempts') AS attempts",
    );
    if (!result.rows[0]?.jobs || !result.rows[0]?.attempts)
      throw new Error("Integration migration is not installed");
  }

  async enqueue(payment: FinalizedPaymentWrite): Promise<{ created: boolean }> {
    const payload = canonical(payment);
    const hash = createHash("sha256").update(payload).digest("hex");
    const result = await this.pool.query(
      `INSERT INTO integration_jobs (transition_id,payload_hash,payload)
       VALUES ($1,$2,$3::jsonb) ON CONFLICT (transition_id) DO NOTHING RETURNING transition_id`,
      [payment.transitionId, hash, payload],
    );
    if (result.rowCount === 1) return { created: true };
    const existing = await this.pool.query(
      "SELECT payload_hash FROM integration_jobs WHERE transition_id=$1",
      [payment.transitionId],
    );
    if (existing.rows[0]?.payload_hash !== hash)
      throw new IntegrationJobConflict("Transition was reused with another integration payload");
    return { created: false };
  }

  async lease(
    owner: string,
    now: Date,
    leaseMilliseconds = 30_000,
  ): Promise<IntegrationJob | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(owner)) throw new Error("Invalid lease owner");
    if (leaseMilliseconds < 1_000 || leaseMilliseconds > 300_000)
      throw new Error("Invalid integration lease duration");
    const leaseToken = randomUUID();
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT transition_id FROM integration_jobs
         WHERE (state IN ('READY','RETRY') AND available_at <= $2)
            OR (state='LEASED' AND lease_until <= $2)
         ORDER BY available_at,created_at,transition_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE integration_jobs j SET state='LEASED',attempts=j.attempts+1,
         lease_owner=$1,lease_token=$3,lease_until=$2 + ($4 * interval '1 millisecond'),
         updated_at=clock_timestamp()
       FROM candidate WHERE j.transition_id=candidate.transition_id RETURNING j.*`,
      [owner, now, leaseToken, leaseMilliseconds],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  async complete(
    job: IntegrationJob,
    result: { salesInvoice: string; paymentEntry: string },
  ): Promise<void> {
    if (!job.leaseToken) throw new IntegrationLeaseLost("Integration lease is missing");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE integration_jobs SET state='COMPLETED',sales_invoice=$3,payment_entry=$4,
           completed_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,lease_until=NULL,
           last_error_code=NULL,updated_at=clock_timestamp()
         WHERE transition_id=$1 AND state='LEASED' AND lease_token=$2`,
        [job.transitionId, job.leaseToken, result.salesInvoice, result.paymentEntry],
      );
      if (updated.rowCount !== 1) throw new IntegrationLeaseLost("Integration lease was lost");
      await client.query(
        `INSERT INTO integration_attempts
          (transition_id,attempt,lease_token,outcome,sales_invoice,payment_entry)
         VALUES ($1,$2,$3,'COMPLETED',$4,$5)`,
        [job.transitionId, job.attempts, job.leaseToken, result.salesInvoice, result.paymentEntry],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(job: IntegrationJob, errorCode: string, retryable: boolean, now: Date): Promise<void> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(errorCode))
      throw new Error("Invalid integration error code");
    const retry = retryable && job.attempts < 8;
    const delaySeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
    const outcome = retry ? "RETRY" : "QUARANTINED";
    if (!job.leaseToken) throw new IntegrationLeaseLost("Integration lease is missing");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE integration_jobs SET state=$3,last_error_code=$4,
           available_at=$5 + ($6 * interval '1 second'),lease_owner=NULL,lease_token=NULL,
           lease_until=NULL,updated_at=clock_timestamp()
         WHERE transition_id=$1 AND state='LEASED' AND lease_token=$2`,
        [job.transitionId, job.leaseToken, outcome, errorCode, now, retry ? delaySeconds : 0],
      );
      if (updated.rowCount !== 1) throw new IntegrationLeaseLost("Integration lease was lost");
      await client.query(
        `INSERT INTO integration_attempts (transition_id,attempt,lease_token,outcome,error_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [job.transitionId, job.attempts, job.leaseToken, outcome, errorCode],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
