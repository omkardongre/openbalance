import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { type Address, getAddress, type Hex, keccak256 } from "viem";

export const financialOperationKinds = [
  "PAYMENT",
  "CANCELLATION",
  "REFUND",
  "RESERVE_OPEN",
  "RESERVE_RECLAIM",
  "WITHDRAWAL",
] as const;

export type FinancialOperationKind = (typeof financialOperationKinds)[number];
export type FinancialOperationState =
  | "ACCEPTED"
  | "LEASED"
  | "SIGNED"
  | "SUBMITTED"
  | "FINALIZED"
  | "RETRY"
  | "FAILED"
  | "QUARANTINED";

export type AcceptFinancialOperation = {
  actorId: string;
  kind: FinancialOperationKind;
  idempotencyKey: string;
  commandDigest: Hex;
  aggregateId: Hex;
  targetAddress: Address;
  calldata: Hex;
  expiresAt: Date;
};

export type SignedTransaction = {
  signerAddress: Address;
  nonce: bigint;
  hash: Hex;
  rawTransaction: Hex;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type FinancialOperation = AcceptFinancialOperation & {
  operationId: string;
  requestHash: Hex;
  state: FinancialOperationState;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: Date | null;
  transaction: SignedTransaction | null;
  replacementLineage: Hex[];
  submittedAt: Date | null;
  finalizedAt: Date | null;
  finalizedBlockNumber: bigint | null;
  finalizedBlockHash: Hex | null;
  failureCode: string | null;
};

type OperationRow = {
  operation_id: string;
  actor_id: string;
  operation_kind: FinancialOperationKind;
  idempotency_key: string;
  request_hash: Hex;
  command_digest: Hex;
  aggregate_id: Hex;
  target_address: Address;
  calldata: Hex;
  state: FinancialOperationState;
  attempts: number;
  next_attempt_at: Date;
  expires_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: Date | null;
  signer_address: Address | null;
  transaction_nonce: string | null;
  transaction_hash: Hex | null;
  raw_transaction: Hex | null;
  gas_limit: string | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  replacement_lineage: unknown;
  submitted_at: Date | null;
  finalized_at: Date | null;
  finalized_block_number: string | null;
  finalized_block_hash: Hex | null;
  failure_code: string | null;
};

export class FinancialOperationConflict extends Error {}
export class FinancialOperationRejected extends Error {}
export class FinancialOperationTransitionRejected extends Error {}
/**
 * Every signing key in the pool has already committed its inflight gas budget. Transient by
 * construction: budget frees as inflight transactions reach a terminal state, so the caller must
 * retry rather than fail the operation or widen the budget.
 */
export class FinancialReserveBudgetExhausted extends Error {}

const address = /^0x[0-9a-fA-F]{40}$/;
const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const calldata = /^0x(?:[0-9a-fA-F]{2})*$/;
const actorIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const idempotencyKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const workerId = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const failureCode = /^[a-z][a-z0-9_]{2,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationKind = new Set<string>(financialOperationKinds);
const maxCalldataBytes = 131_072;

function normalize(input: AcceptFinancialOperation): AcceptFinancialOperation {
  if (
    !actorIdPattern.test(input.actorId) ||
    !operationKind.has(input.kind) ||
    !idempotencyKey.test(input.idempotencyKey) ||
    !bytes32.test(input.commandDigest) ||
    !bytes32.test(input.aggregateId) ||
    input.commandDigest.toLowerCase() === `0x${"00".repeat(32)}` ||
    input.aggregateId.toLowerCase() === `0x${"00".repeat(32)}` ||
    !address.test(input.targetAddress) ||
    !calldata.test(input.calldata) ||
    (input.calldata.length - 2) / 2 > maxCalldataBytes ||
    !(input.expiresAt instanceof Date) ||
    !Number.isFinite(input.expiresAt.getTime())
  )
    throw new FinancialOperationRejected("Invalid financial operation");
  return {
    ...input,
    commandDigest: input.commandDigest.toLowerCase() as Hex,
    aggregateId: input.aggregateId.toLowerCase() as Hex,
    targetAddress: input.targetAddress.toLowerCase() as Address,
    calldata: input.calldata.toLowerCase() as Hex,
  };
}

export function financialOperationHash(input: AcceptFinancialOperation): Hex {
  const value = normalize(input);
  const canonical = JSON.stringify([
    value.actorId,
    value.kind,
    value.commandDigest,
    value.aggregateId,
    value.targetAddress,
    value.calldata,
    value.expiresAt.toISOString(),
  ]);
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

function parseLineage(value: unknown): Hex[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !bytes32.test(item))
  )
    throw new FinancialOperationRejected("Stored replacement lineage is invalid");
  return value.map((item) => item.toLowerCase() as Hex);
}

function operation(row: OperationRow): FinancialOperation {
  const hasTransaction = row.transaction_hash !== null;
  const transaction = hasTransaction
    ? {
        signerAddress: row.signer_address as Address,
        nonce: BigInt(row.transaction_nonce as string),
        hash: row.transaction_hash as Hex,
        rawTransaction: row.raw_transaction as Hex,
        gasLimit: BigInt(row.gas_limit as string),
        maxFeePerGas: BigInt(row.max_fee_per_gas as string),
        maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas as string),
      }
    : null;
  return {
    operationId: row.operation_id,
    actorId: row.actor_id,
    kind: row.operation_kind,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    commandDigest: row.command_digest,
    aggregateId: row.aggregate_id,
    targetAddress: row.target_address,
    calldata: row.calldata,
    expiresAt: row.expires_at,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    transaction,
    replacementLineage: parseLineage(row.replacement_lineage),
    submittedAt: row.submitted_at,
    finalizedAt: row.finalized_at,
    finalizedBlockNumber:
      row.finalized_block_number === null ? null : BigInt(row.finalized_block_number),
    finalizedBlockHash: row.finalized_block_hash,
    failureCode: row.failure_code,
  };
}

function validateSignedTransaction(transaction: SignedTransaction): SignedTransaction {
  if (
    !address.test(transaction.signerAddress) ||
    !bytes32.test(transaction.hash) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(transaction.rawTransaction) ||
    keccak256(transaction.rawTransaction).toLowerCase() !== transaction.hash.toLowerCase() ||
    transaction.nonce < 0n ||
    transaction.gasLimit < 21_000n ||
    transaction.maxFeePerGas < 1n ||
    transaction.maxPriorityFeePerGas < 0n ||
    transaction.maxPriorityFeePerGas > transaction.maxFeePerGas
  )
    throw new FinancialOperationRejected("Invalid signed transaction");
  return {
    ...transaction,
    signerAddress: transaction.signerAddress.toLowerCase() as Address,
    hash: transaction.hash.toLowerCase() as Hex,
    rawTransaction: transaction.rawTransaction.toLowerCase() as Hex,
  };
}

export class FinancialOperationJournal {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      `SELECT to_regclass('public.financial_operations') AS operations,
              to_regclass('public.relayer_nonce_cursors') AS cursors,
              to_regclass('public.relayer_nonce_reservations') AS reservations`,
    );
    if (!result.rows[0]?.operations || !result.rows[0]?.cursors || !result.rows[0]?.reservations)
      throw new Error("Financial operation database migration is not installed");
  }

  async accept(
    input: AcceptFinancialOperation,
  ): Promise<{ created: boolean; operation: FinancialOperation }> {
    const value = normalize(input);
    if (value.expiresAt.getTime() <= Date.now())
      throw new FinancialOperationRejected("Financial operation has expired");
    const requestHash = financialOperationHash(value);
    const operationId = randomUUID();
    const result = await this.pool.query<OperationRow>(
      `INSERT INTO financial_operations
       (operation_id,actor_id,operation_kind,idempotency_key,request_hash,command_digest,
        aggregate_id,target_address,calldata,state,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACCEPTED',$10)
       ON CONFLICT (actor_id,operation_kind,idempotency_key) DO NOTHING
       RETURNING *`,
      [
        operationId,
        value.actorId,
        value.kind,
        value.idempotencyKey,
        requestHash,
        value.commandDigest,
        value.aggregateId,
        value.targetAddress,
        value.calldata,
        value.expiresAt,
      ],
    );
    if (result.rows[0]) return { created: true, operation: operation(result.rows[0]) };
    const prior = await this.pool.query<OperationRow>(
      `SELECT * FROM financial_operations
       WHERE actor_id=$1 AND operation_kind=$2 AND idempotency_key=$3`,
      [value.actorId, value.kind, value.idempotencyKey],
    );
    if (!prior.rows[0] || prior.rows[0].request_hash !== requestHash)
      throw new FinancialOperationConflict("Idempotency key conflicts with another command");
    return { created: false, operation: operation(prior.rows[0]) };
  }

  async get(operationId: string): Promise<FinancialOperation | null> {
    if (!uuid.test(operationId)) throw new FinancialOperationRejected("Invalid operation ID");
    const result = await this.pool.query<OperationRow>(
      "SELECT * FROM financial_operations WHERE operation_id=$1",
      [operationId],
    );
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async getForActor(operationId: string, actorId: string): Promise<FinancialOperation | null> {
    if (!uuid.test(operationId) || !actorIdPattern.test(actorId))
      throw new FinancialOperationRejected("Invalid operation lookup");
    const result = await this.pool.query<OperationRow>(
      "SELECT * FROM financial_operations WHERE operation_id=$1 AND actor_id=$2",
      [operationId, actorId],
    );
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async claim(
    limit: number,
    owner: string,
    leaseMilliseconds: number,
  ): Promise<FinancialOperation[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !workerId.test(owner) ||
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1_000 ||
      leaseMilliseconds > 300_000
    )
      throw new FinancialOperationRejected("Invalid lease request");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<OperationRow>(
        `WITH ready AS (
           SELECT operation_id FROM financial_operations
           WHERE state IN ('ACCEPTED','RETRY')
             AND next_attempt_at <= clock_timestamp()
             AND expires_at > clock_timestamp()
           ORDER BY next_attempt_at,created_at,operation_id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE financial_operations o
         SET state='LEASED',attempts=o.attempts+1,lease_owner=$2,
             lease_token=gen_random_uuid(),
             lease_until=clock_timestamp()+($3::text || ' milliseconds')::interval,
             updated_at=clock_timestamp()
         FROM ready WHERE o.operation_id=ready.operation_id
         RETURNING o.*`,
        [limit, owner, leaseMilliseconds],
      );
      await client.query("COMMIT");
      return result.rows.map(operation);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE financial_operations
       SET state=CASE WHEN expires_at <= clock_timestamp() THEN 'FAILED' ELSE 'RETRY' END,
           lease_owner=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),
           failure_code=CASE WHEN expires_at <= clock_timestamp()
             THEN 'command_expired' ELSE 'lease_expired' END,updated_at=clock_timestamp()
       WHERE state='LEASED' AND lease_until <= clock_timestamp()`,
    );
    return result.rowCount ?? 0;
  }

  async expireUnclaimed(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE financial_operations
       SET state='FAILED',failure_code='command_expired',updated_at=clock_timestamp()
       WHERE state IN ('ACCEPTED','RETRY') AND expires_at <= clock_timestamp()`,
    );
    return result.rowCount ?? 0;
  }

  async listForReconciliation(limit: number): Promise<FinancialOperation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new FinancialOperationRejected("Invalid reconciliation limit");
    const result = await this.pool.query<OperationRow>(
      `SELECT * FROM financial_operations
       WHERE state IN ('SIGNED','SUBMITTED') AND next_attempt_at <= clock_timestamp()
       ORDER BY next_attempt_at,created_at,operation_id LIMIT $1`,
      [limit],
    );
    return result.rows.map(operation);
  }

  async deferReconciliation(
    operationId: string,
    transactionHash: Hex,
    delayMilliseconds: number,
    code: string,
  ): Promise<FinancialOperation> {
    if (
      !uuid.test(operationId) ||
      !bytes32.test(transactionHash) ||
      !Number.isSafeInteger(delayMilliseconds) ||
      delayMilliseconds < 1_000 ||
      delayMilliseconds > 86_400_000 ||
      !failureCode.test(code)
    )
      throw new FinancialOperationRejected("Invalid reconciliation delay");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET next_attempt_at=clock_timestamp()+($3::text || ' milliseconds')::interval,
           failure_code=$4,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state IN ('SIGNED','SUBMITTED') AND transaction_hash=$2
       RETURNING *`,
      [operationId, transactionHash.toLowerCase(), delayMilliseconds, code],
    );
    return this.transition(
      result.rows[0],
      "Reconciliation transaction does not match current state",
    );
  }

  /**
   * Chooses a signing key with enough remaining inflight gas budget and reserves its next nonce, in
   * one transaction.
   *
   * Selection and reservation cannot be separate steps. The chain bounds the summed gas spend of one
   * account's inflight transactions, and exceeding that bound makes consensus *exclude* the
   * transaction instead of including and reverting it — an outcome indistinguishable from a dropped
   * network call at the point of broadcast. Two workers that each read a key's remaining budget and
   * then independently decided to use it could therefore both overcommit it and lose transactions
   * silently. Holding the key's cursor row while measuring its committed budget makes the decision
   * and the reservation atomic per key.
   *
   * Committed budget is summed live from the operations still inflight rather than kept in a counter,
   * so it releases when a transaction reaches a terminal state with no separate bookkeeping to drift.
   *
   * Candidates are locked in address order so concurrent workers acquire the same locks in the same
   * sequence and cannot deadlock against each other.
   */
  async reserveNonceFromPool(
    operationId: string,
    leaseToken: string,
    candidates: readonly {
      signerAddress: Address;
      pendingNonce: bigint;
      budgetWei: bigint | null;
    }[],
    commitmentWei: bigint,
  ): Promise<{ signerAddress: Address; nonce: bigint }> {
    if (
      !uuid.test(operationId) ||
      !uuid.test(leaseToken) ||
      candidates.length === 0 ||
      commitmentWei <= 0n ||
      candidates.some(
        (candidate) =>
          !address.test(candidate.signerAddress) ||
          candidate.pendingNonce < 0n ||
          (candidate.budgetWei !== null && candidate.budgetWei < 0n),
      )
    )
      throw new FinancialOperationRejected("Invalid nonce reservation");
    const ordered = [...candidates]
      .map((candidate) => ({ ...candidate, signer: candidate.signerAddress.toLowerCase() }))
      .sort((left, right) =>
        left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0,
      );
    if (new Set(ordered.map((candidate) => candidate.signer)).size !== ordered.length)
      throw new FinancialOperationRejected("Duplicate signing key in pool");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const leased = await client.query(
        `SELECT operation_id FROM financial_operations
         WHERE operation_id=$1 AND state='LEASED' AND lease_token=$2
           AND lease_until > clock_timestamp() AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [operationId, leaseToken],
      );
      if (!leased.rows[0])
        throw new FinancialOperationTransitionRejected(
          "Nonce reservation lease is stale or invalid",
        );
      // A retry after an uncertain crash must return the original reservation. The signed bytes may
      // already be committed to that key and nonce, so the recorded choice outranks a fresh one even
      // if the key has since left the pool.
      const existing = await client.query<{
        signer_address: string;
        transaction_nonce: string;
      }>(
        "SELECT signer_address,transaction_nonce FROM relayer_nonce_reservations WHERE operation_id=$1",
        [operationId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return {
          signerAddress: getAddress(existing.rows[0].signer_address as Address),
          nonce: BigInt(existing.rows[0].transaction_nonce),
        };
      }
      for (const candidate of ordered) {
        await client.query(
          `INSERT INTO relayer_nonce_cursors (signer_address,next_nonce)
           VALUES ($1,$2) ON CONFLICT (signer_address) DO NOTHING`,
          [candidate.signer, candidate.pendingNonce.toString()],
        );
        const cursor = await client.query<{ next_nonce: string }>(
          "SELECT next_nonce FROM relayer_nonce_cursors WHERE signer_address=$1 FOR UPDATE",
          [candidate.signer],
        );
        if (!cursor.rows[0])
          throw new FinancialOperationRejected("Relayer nonce cursor is unavailable");
        if (candidate.budgetWei !== null) {
          const committed = await client.query<{ committed: string | null }>(
            `SELECT SUM(gas_limit * max_fee_per_gas)::text AS committed FROM financial_operations
             WHERE signer_address=$1 AND state IN ('SIGNED','SUBMITTED')`,
            [candidate.signer],
          );
          const inflight = BigInt(committed.rows[0]?.committed ?? "0");
          if (inflight + commitmentWei > candidate.budgetWei) continue;
        }
        const storedNonce = BigInt(cursor.rows[0].next_nonce);
        const reservedNonce =
          storedNonce > candidate.pendingNonce ? storedNonce : candidate.pendingNonce;
        await client.query(
          `INSERT INTO relayer_nonce_reservations (operation_id,signer_address,transaction_nonce)
           VALUES ($1,$2,$3)`,
          [operationId, candidate.signer, reservedNonce.toString()],
        );
        await client.query(
          `UPDATE relayer_nonce_cursors
           SET next_nonce=$2,updated_at=clock_timestamp() WHERE signer_address=$1`,
          [candidate.signer, (reservedNonce + 1n).toString()],
        );
        await client.query("COMMIT");
        return {
          signerAddress: getAddress(candidate.signerAddress),
          nonce: reservedNonce,
        };
      }
      throw new FinancialReserveBudgetExhausted(
        "Every signing key has committed its inflight gas budget",
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSigned(
    operationId: string,
    leaseToken: string,
    transaction: SignedTransaction,
  ): Promise<FinancialOperation> {
    if (!uuid.test(operationId) || !uuid.test(leaseToken))
      throw new FinancialOperationRejected("Invalid signing identity");
    const value = validateSignedTransaction(transaction);
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='SIGNED',signer_address=$3,transaction_nonce=$4,transaction_hash=$5,
           raw_transaction=$6,gas_limit=$7,max_fee_per_gas=$8,max_priority_fee_per_gas=$9,
           lease_owner=NULL,lease_token=NULL,lease_until=NULL,failure_code=NULL,
           updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state='LEASED' AND lease_token=$2
         AND lease_until > clock_timestamp() AND expires_at > clock_timestamp()
         AND EXISTS (
           SELECT 1 FROM relayer_nonce_reservations r
           WHERE r.operation_id=financial_operations.operation_id
             AND r.signer_address=$3 AND r.transaction_nonce=$4
         )
       RETURNING *`,
      [
        operationId,
        leaseToken,
        value.signerAddress,
        value.nonce.toString(),
        value.hash,
        value.rawTransaction,
        value.gasLimit.toString(),
        value.maxFeePerGas.toString(),
        value.maxPriorityFeePerGas.toString(),
      ],
    );
    return this.transition(result.rows[0], "Signing lease is stale or invalid");
  }

  async replaceSigned(
    operationId: string,
    expectedHash: Hex,
    transaction: SignedTransaction,
  ): Promise<FinancialOperation> {
    const value = validateSignedTransaction(transaction);
    if (!uuid.test(operationId) || !bytes32.test(expectedHash))
      throw new FinancialOperationRejected("Invalid transaction hash");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='SIGNED',transaction_hash=$3,raw_transaction=$4,gas_limit=$5,
           max_fee_per_gas=$6,max_priority_fee_per_gas=$7,
           replacement_lineage=replacement_lineage || to_jsonb(transaction_hash),
           submitted_at=NULL,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state IN ('SIGNED','SUBMITTED') AND transaction_hash=$2
         AND signer_address=$8 AND transaction_nonce=$9 AND expires_at > clock_timestamp()
         AND $6::numeric > max_fee_per_gas AND $7::numeric > max_priority_fee_per_gas
       RETURNING *`,
      [
        operationId,
        expectedHash.toLowerCase(),
        value.hash,
        value.rawTransaction,
        value.gasLimit.toString(),
        value.maxFeePerGas.toString(),
        value.maxPriorityFeePerGas.toString(),
        value.signerAddress,
        value.nonce.toString(),
      ],
    );
    return this.transition(result.rows[0], "Replacement does not match current transaction");
  }

  async markSubmitted(operationId: string, transactionHash: Hex): Promise<FinancialOperation> {
    if (!uuid.test(operationId) || !bytes32.test(transactionHash))
      throw new FinancialOperationRejected("Invalid transaction hash");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='SUBMITTED',submitted_at=COALESCE(submitted_at,clock_timestamp()),updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state IN ('SIGNED','SUBMITTED') AND transaction_hash=$2
       RETURNING *`,
      [operationId, transactionHash.toLowerCase()],
    );
    return this.transition(result.rows[0], "Submitted transaction does not match signed bytes");
  }

  async markFinalized(
    operationId: string,
    transactionHash: Hex,
    blockNumber: bigint,
    blockHash: Hex,
  ): Promise<FinancialOperation> {
    if (
      !uuid.test(operationId) ||
      !bytes32.test(transactionHash) ||
      !bytes32.test(blockHash) ||
      blockNumber < 0n
    )
      throw new FinancialOperationRejected("Invalid finality proof");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='FINALIZED',finalized_at=COALESCE(finalized_at,clock_timestamp()),
           finalized_block_number=$3,finalized_block_hash=$4,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state IN ('SIGNED','SUBMITTED','FINALIZED')
         AND transaction_hash=$2
         AND (state!='FINALIZED' OR (finalized_block_number=$3 AND finalized_block_hash=$4))
       RETURNING *`,
      [operationId, transactionHash.toLowerCase(), blockNumber.toString(), blockHash.toLowerCase()],
    );
    return this.transition(result.rows[0], "Finality proof conflicts with the signed transaction");
  }

  async retry(
    operationId: string,
    leaseToken: string,
    delayMilliseconds: number,
    code: string,
  ): Promise<FinancialOperation> {
    if (
      !Number.isSafeInteger(delayMilliseconds) ||
      delayMilliseconds < 1_000 ||
      delayMilliseconds > 86_400_000 ||
      !uuid.test(operationId) ||
      !uuid.test(leaseToken) ||
      !failureCode.test(code)
    )
      throw new FinancialOperationRejected("Invalid retry request");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='RETRY',next_attempt_at=clock_timestamp()+($3::text || ' milliseconds')::interval,
           failure_code=$4,lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state='LEASED' AND lease_token=$2 AND lease_until > clock_timestamp()
       RETURNING *`,
      [operationId, leaseToken, delayMilliseconds, code],
    );
    return this.transition(result.rows[0], "Retry lease is stale or invalid");
  }

  async failBeforeSigning(
    operationId: string,
    leaseToken: string,
    code: string,
  ): Promise<FinancialOperation> {
    if (!uuid.test(operationId) || !uuid.test(leaseToken) || !failureCode.test(code))
      throw new FinancialOperationRejected("Invalid failure request");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='FAILED',failure_code=$3,lease_owner=NULL,lease_token=NULL,lease_until=NULL,
           updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state='LEASED' AND lease_token=$2 AND lease_until > clock_timestamp()
       RETURNING *`,
      [operationId, leaseToken, code],
    );
    return this.transition(result.rows[0], "Failure lease is stale or invalid");
  }

  async markReverted(
    operationId: string,
    transactionHash: Hex,
    code: string,
  ): Promise<FinancialOperation> {
    if (!uuid.test(operationId) || !bytes32.test(transactionHash) || !failureCode.test(code))
      throw new FinancialOperationRejected("Invalid reverted transaction");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations SET state='FAILED',failure_code=$3,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state IN ('SIGNED','SUBMITTED') AND transaction_hash=$2
       RETURNING *`,
      [operationId, transactionHash.toLowerCase(), code],
    );
    return this.transition(result.rows[0], "Reverted transaction does not match current state");
  }

  async quarantine(
    operationId: string,
    expectedState: FinancialOperationState,
    code: string,
  ): Promise<FinancialOperation> {
    if (
      !failureCode.test(code) ||
      !uuid.test(operationId) ||
      !new Set<FinancialOperationState>(["ACCEPTED", "RETRY", "SIGNED", "SUBMITTED"]).has(
        expectedState,
      )
    )
      throw new FinancialOperationRejected("Invalid quarantine request");
    const result = await this.pool.query<OperationRow>(
      `UPDATE financial_operations
       SET state='QUARANTINED',failure_code=$3,lease_owner=NULL,lease_token=NULL,lease_until=NULL,
           updated_at=clock_timestamp()
       WHERE operation_id=$1 AND state=$2 RETURNING *`,
      [operationId, expectedState, code],
    );
    return this.transition(result.rows[0], "Operation is not in the expected state");
  }

  private transition(row: OperationRow | undefined, message: string): FinancialOperation {
    if (!row) throw new FinancialOperationTransitionRejected(message);
    return operation(row);
  }
}
