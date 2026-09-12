import type { Pool } from "pg";
import { keccak256 } from "viem";
import { expect, it, vi } from "vitest";
import {
  type AcceptFinancialOperation,
  FinancialOperationConflict,
  FinancialOperationJournal,
  FinancialOperationRejected,
  financialOperationHash,
} from "../src/financial-operations.js";

const operation: AcceptFinancialOperation = {
  actorId: "account:0x1234",
  kind: "PAYMENT",
  idempotencyKey: "payment:checkout:0001",
  commandDigest: `0x${"11".repeat(32)}`,
  aggregateId: `0x${"22".repeat(32)}`,
  targetAddress: `0x${"Aa".repeat(20)}`,
  calldata: "0x1234",
  expiresAt: new Date("2100-10-01T12:00:00.000Z"),
};

it("hashes the complete normalized economic command and rejects malformed input", () => {
  expect(financialOperationHash(operation)).toBe(
    financialOperationHash({
      ...operation,
      targetAddress: operation.targetAddress.toLowerCase() as `0x${string}`,
    }),
  );
  expect(() => financialOperationHash({ ...operation, calldata: "0x1" })).toThrow(
    FinancialOperationRejected,
  );
  expect(() => financialOperationHash({ ...operation, expiresAt: new Date(Number.NaN) })).toThrow(
    FinancialOperationRejected,
  );
});

it("fails idempotency conflicts closed and verifies signed bytes before persistence", async () => {
  const requestHash = financialOperationHash(operation);
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          operation_id: "89eb1051-a21c-4b66-b97c-f5f551299692",
          actor_id: operation.actorId,
          operation_kind: operation.kind,
          idempotency_key: operation.idempotencyKey,
          request_hash: `0x${"ff".repeat(32)}`,
          command_digest: operation.commandDigest.toLowerCase(),
          aggregate_id: operation.aggregateId.toLowerCase(),
          target_address: operation.targetAddress.toLowerCase(),
          calldata: operation.calldata,
          state: "ACCEPTED",
          attempts: 0,
          next_attempt_at: new Date(),
          expires_at: operation.expiresAt,
          lease_owner: null,
          lease_token: null,
          lease_until: null,
          signer_address: null,
          transaction_nonce: null,
          transaction_hash: null,
          raw_transaction: null,
          gas_limit: null,
          max_fee_per_gas: null,
          max_priority_fee_per_gas: null,
          replacement_lineage: [],
          submitted_at: null,
          finalized_at: null,
          finalized_block_number: null,
          finalized_block_hash: null,
          failure_code: null,
        },
      ],
    });
  const journal = new FinancialOperationJournal({ query } as unknown as Pool);
  await expect(journal.accept(operation)).rejects.toThrow(FinancialOperationConflict);
  expect(requestHash).not.toBe(`0x${"ff".repeat(32)}`);

  const rawTransaction = "0x1234" as const;
  await expect(
    journal.markSigned("89eb1051-a21c-4b66-b97c-f5f551299692", crypto.randomUUID(), {
      signerAddress: `0x${"33".repeat(20)}`,
      nonce: 1n,
      hash: `0x${"44".repeat(32)}`,
      rawTransaction,
      gasLimit: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    }),
  ).rejects.toThrow(FinancialOperationRejected);
  expect(keccak256(rawTransaction)).not.toBe(`0x${"44".repeat(32)}`);
  expect(query).toHaveBeenCalledTimes(2);
});
