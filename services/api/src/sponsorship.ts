import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Pool } from "pg";
import {
  type Address,
  BaseError,
  type Hex,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { DeploymentMismatch, type DeploymentParameters } from "./deployment-chain.js";
import type { DeploymentService } from "./deployments.js";
import { EnrollmentRejected } from "./enrollment.js";

export class SponsorshipUnavailable extends Error {}
export class SponsorshipConflict extends Error {}
export class SponsorshipQuotaExceeded extends Error {}

export type SponsorshipPolicy = {
  dailyDeployments: number;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxCost: bigint;
};
type SponsorshipRow = {
  id: string;
  enrollment_id: string;
  idempotency_key: string;
  request_hash: Hex;
  transaction_hash: Hex;
  raw_transaction: Hex;
  state: "signed" | "submitted" | "confirmed" | "reverted";
};

const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
const deploymentDigest = (to: Address, data: Hex, chainId: number) =>
  keccak256(`0x${Buffer.from(`${chainId}:${to}:${data}`).toString("hex")}`);

export async function loadSponsorAccount(path: string): Promise<PrivateKeyAccount> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new Error("Sponsor key file must be a private regular file");
    const value = (await handle.readFile("utf8")).trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Sponsor key file is invalid");
    return privateKeyToAccount(value as Hex);
  } finally {
    await handle.close();
  }
}

export class DeploymentSponsorshipService {
  constructor(
    private readonly pool: Pool,
    private readonly deployments: DeploymentService,
    private readonly signer: PrivateKeyAccount,
    private readonly policy: SponsorshipPolicy,
  ) {
    if (
      !Number.isSafeInteger(policy.dailyDeployments) ||
      policy.dailyDeployments < 1 ||
      policy.maxGas < 21_000n ||
      policy.maxFeePerGas < 1n ||
      policy.maxCost < 1n
    )
      throw new Error("Invalid sponsorship policy");
  }

  async process(token: string, idempotencyKey: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new EnrollmentRejected();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey))
      throw new SponsorshipConflict();
    const prepared = await this.deployments.process(token);
    const enrollment = (
      await this.pool.query(
        `SELECT e.id FROM account_enrollments e
         JOIN account_deployments d ON d.enrollment_id=e.id
         WHERE e.token_hash=$1 AND e.status='verified'
           AND e.verified_at > clock_timestamp()-interval '30 minutes'
           AND d.account_address=$2 AND d.manifest_hash=$3`,
        [tokenDigest(token), prepared.account, this.deployments.chain.manifestHash],
      )
    ).rows[0];
    if (!enrollment) throw new EnrollmentRejected();
    const requestHash = deploymentDigest(
      prepared.transaction.to,
      prepared.transaction.data,
      prepared.manifest.chainId,
    );
    const existing = await this.pool.query(
      "SELECT * FROM deployment_sponsorships WHERE enrollment_id=$1",
      [enrollment.id],
    );
    if (existing.rows[0])
      return this.reconcile(existing.rows[0], idempotencyKey, requestHash, prepared.parameters);
    if (prepared.status === "confirmed")
      return { status: "confirmed" as const, account: prepared.account };

    const client = this.deployments.chain.client;
    const [estimatedGas, fees] = await Promise.all([
      client.estimateGas({
        account: this.signer.address,
        to: prepared.transaction.to,
        data: prepared.transaction.data,
        value: 0n,
      }),
      client.estimateFeesPerGas(),
    ]);
    const gas = (estimatedGas * 120n + 99n) / 100n;
    const maxFeePerGas = fees.maxFeePerGas;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    if (
      gas > this.policy.maxGas ||
      maxFeePerGas > this.policy.maxFeePerGas ||
      gas * maxFeePerGas > this.policy.maxCost
    )
      throw new SponsorshipUnavailable();

    const db = await this.pool.connect();
    let row: SponsorshipRow;
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [784_906_211]);
      const prior = (
        await db.query("SELECT * FROM deployment_sponsorships WHERE enrollment_id=$1", [
          enrollment.id,
        ])
      ).rows[0] as SponsorshipRow;
      if (prior) {
        await db.query("COMMIT");
        return this.reconcile(prior, idempotencyKey, requestHash, prepared.parameters);
      }
      const count = Number(
        (
          await db.query(
            `SELECT count(*) FROM deployment_sponsorships
             WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          )
        ).rows[0].count,
      );
      if (count >= this.policy.dailyDeployments) throw new SponsorshipQuotaExceeded();
      const pendingNonce = await client.getTransactionCount({
        address: this.signer.address,
        blockTag: "pending",
      });
      const reserved = (
        await db.query(
          "SELECT max(sponsor_nonce)::text AS nonce FROM deployment_sponsorships WHERE sponsor_address=$1",
          [this.signer.address],
        )
      ).rows[0].nonce;
      const nextReserved = reserved === null ? 0n : BigInt(reserved) + 1n;
      const nonceValue = nextReserved > BigInt(pendingNonce) ? nextReserved : BigInt(pendingNonce);
      if (nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new SponsorshipUnavailable();
      const nonce = Number(nonceValue);
      const raw = await this.signer.signTransaction({
        chainId: prepared.manifest.chainId,
        type: "eip1559",
        to: prepared.transaction.to,
        data: prepared.transaction.data,
        value: 0n,
        gas,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const transactionHash = keccak256(raw);
      row = (
        await db.query(
          `INSERT INTO deployment_sponsorships
           (id,enrollment_id,idempotency_key,request_hash,sponsor_address,sponsor_nonce,
            transaction_hash,raw_transaction,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'signed') RETURNING *`,
          [
            randomUUID(),
            enrollment.id,
            idempotencyKey,
            requestHash,
            this.signer.address,
            nonce,
            transactionHash,
            raw,
            gas.toString(),
            maxFeePerGas.toString(),
            maxPriorityFeePerGas.toString(),
          ],
        )
      ).rows[0];
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
    return this.broadcast(row);
  }

  async reconcilePending(limit = 25) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid limit");
    const rows = (
      await this.pool.query(
        `SELECT s.*,d.parameters FROM deployment_sponsorships s
         JOIN account_deployments d ON d.enrollment_id=s.enrollment_id
         WHERE s.state IN ('signed','submitted') ORDER BY s.created_at LIMIT $1`,
        [limit],
      )
    ).rows as (SponsorshipRow & { parameters: DeploymentParameters })[];
    let confirmed = 0;
    let pending = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const result = await this.reconcile(
          row,
          row.idempotency_key,
          row.request_hash,
          row.parameters,
        );
        if (result.status === "confirmed") confirmed += 1;
        else pending += 1;
      } catch (error) {
        if (
          error instanceof SponsorshipUnavailable ||
          error instanceof DeploymentMismatch ||
          error instanceof BaseError
        )
          failed += 1;
        else throw error;
      }
    }
    return { inspected: rows.length, confirmed, pending, failed };
  }

  private async reconcile(
    row: SponsorshipRow,
    idempotencyKey: string,
    requestHash: Hex,
    parameters: DeploymentParameters,
  ) {
    if (row.idempotency_key !== idempotencyKey || row.request_hash !== requestHash)
      throw new SponsorshipConflict();
    if (row.state === "reverted") throw new SponsorshipUnavailable();
    const prepared = await this.deployments.chain.prepare(parameters);
    const observation = await this.deployments.chain.confirm(prepared.account, parameters);
    if (observation.status === "confirmed") {
      await this.pool.query(
        `UPDATE deployment_sponsorships SET state='confirmed',confirmed_at=COALESCE(confirmed_at,now())
         WHERE id=$1`,
        [row.id],
      );
      return {
        status: "confirmed" as const,
        account: prepared.account,
        transactionHash: row.transaction_hash as Hex,
      };
    }
    try {
      const receipt = await this.deployments.chain.client.getTransactionReceipt({
        hash: row.transaction_hash,
      });
      if (receipt.status === "reverted") {
        await this.pool.query(
          "UPDATE deployment_sponsorships SET state='reverted',failure_code='transaction_reverted' WHERE id=$1",
          [row.id],
        );
        throw new SponsorshipUnavailable();
      }
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    try {
      await this.deployments.chain.client.getTransaction({ hash: row.transaction_hash as Hex });
      return {
        status: "submitted" as const,
        account: prepared.account,
        transactionHash: row.transaction_hash as Hex,
      };
    } catch (error) {
      if (!(error instanceof TransactionNotFoundError)) throw error;
      return this.broadcast(row);
    }
  }

  private async broadcast(row: SponsorshipRow) {
    let hash: Hex;
    try {
      hash = await this.deployments.chain.client.sendRawTransaction({
        serializedTransaction: row.raw_transaction,
      });
    } catch (error) {
      try {
        const transaction = await this.deployments.chain.client.getTransaction({
          hash: row.transaction_hash,
        });
        hash = transaction.hash;
      } catch (lookupError) {
        if (lookupError instanceof TransactionNotFoundError) throw error;
        throw lookupError;
      }
    }
    if (hash.toLowerCase() !== String(row.transaction_hash).toLowerCase())
      throw new SponsorshipUnavailable();
    await this.pool.query(
      `UPDATE deployment_sponsorships SET state='submitted',submitted_at=COALESCE(submitted_at,now())
       WHERE id=$1 AND state='signed'`,
      [row.id],
    );
    return {
      status: "submitted" as const,
      transactionHash: hash,
      account: (
        await this.pool.query(
          "SELECT account_address FROM account_deployments WHERE enrollment_id=$1",
          [row.enrollment_id],
        )
      ).rows[0].account_address as Address,
    };
  }
}
