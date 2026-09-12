import { expect, it, vi } from "vitest";
import type { FinancialOperation, SignedTransaction } from "../src/financial-operations.js";
import {
  BoundedFinancialCommandPolicy,
  type FinancialFinalityVerifier,
  type FinancialOperationJournalPort,
  FinancialOperationWorker,
  type FinancialTransactionGateway,
} from "../src/financial-worker.js";

const operationId = "89eb1051-a21c-4b66-b97c-f5f551299692";
const leaseToken = "93ab1051-a21c-4b66-b97c-f5f551299692";
const signer = `0x${"33".repeat(20)}` as const;
const target = `0x${"44".repeat(20)}` as const;
const transaction: SignedTransaction = {
  signerAddress: signer,
  nonce: 7n,
  hash: `0x${"55".repeat(32)}`,
  rawTransaction: "0x1234",
  gasLimit: 100_000n,
  maxFeePerGas: 20n,
  maxPriorityFeePerGas: 2n,
};

function financialOperation(overrides: Partial<FinancialOperation> = {}): FinancialOperation {
  return {
    operationId,
    actorId: "account:0x1234",
    kind: "PAYMENT",
    idempotencyKey: "payment:checkout:0001",
    requestHash: `0x${"11".repeat(32)}`,
    commandDigest: `0x${"22".repeat(32)}`,
    aggregateId: `0x${"23".repeat(32)}`,
    targetAddress: target,
    calldata: "0x12345678",
    expiresAt: new Date("2100-10-01T12:00:00.000Z"),
    state: "LEASED",
    attempts: 1,
    nextAttemptAt: new Date(),
    leaseOwner: "worker:relayer:1",
    leaseToken,
    leaseUntil: new Date("2100-10-01T12:05:00.000Z"),
    transaction: null,
    replacementLineage: [],
    submittedAt: null,
    finalizedAt: null,
    finalizedBlockNumber: null,
    finalizedBlockHash: null,
    failureCode: null,
    ...overrides,
  };
}

function journal(overrides: Partial<FinancialOperationJournalPort> = {}) {
  return {
    recoverExpiredLeases: vi.fn(async () => 0),
    expireUnclaimed: vi.fn(async () => 0),
    listForReconciliation: vi.fn(async () => []),
    claim: vi.fn(async () => []),
    reserveNonce: vi.fn(async () => transaction.nonce),
    markSigned: vi.fn(async () => financialOperation({ state: "SIGNED", transaction })),
    markSubmitted: vi.fn(async () => financialOperation({ state: "SUBMITTED", transaction })),
    markFinalized: vi.fn(async () => financialOperation({ state: "FINALIZED", transaction })),
    markReverted: vi.fn(async () => financialOperation({ state: "FAILED", transaction })),
    deferReconciliation: vi.fn(async () => financialOperation({ state: "SIGNED", transaction })),
    retry: vi.fn(async () => financialOperation({ state: "RETRY" })),
    failBeforeSigning: vi.fn(async () => financialOperation({ state: "FAILED" })),
    quarantine: vi.fn(async () => financialOperation({ state: "QUARANTINED" })),
    ...overrides,
  } as unknown as FinancialOperationJournalPort;
}

function gateway(
  overrides: Partial<FinancialTransactionGateway> = {},
): FinancialTransactionGateway {
  return {
    chainId: 10_143,
    signerAddress: signer,
    pendingNonce: vi.fn(async () => transaction.nonce),
    simulate: vi.fn(async () => ({
      gasLimit: transaction.gasLimit,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    })),
    sign: vi.fn(async () => transaction),
    broadcast: vi.fn(async () => transaction.hash),
    ...overrides,
  };
}

function worker(
  operationJournal: FinancialOperationJournalPort,
  transactionGateway: FinancialTransactionGateway,
  inspect: FinancialFinalityVerifier["inspect"] = async () => ({ status: "PENDING" }),
) {
  return new FinancialOperationWorker({
    journal: operationJournal,
    gateway: transactionGateway,
    finality: { inspect },
    policy: new BoundedFinancialCommandPolicy({
      chainId: 10_143,
      rules: [{ kind: "PAYMENT", targetAddress: target, selector: "0x12345678" }],
      maxGasLimit: 200_000n,
      maxFeePerGas: 100n,
      maxCost: 20_000_000n,
    }),
    owner: "worker:relayer:1",
  });
}

it("persists an approved signed command before broadcasting it", async () => {
  const order: string[] = [];
  const markSigned = vi.fn(async () => {
    order.push("signed");
    return financialOperation({ state: "SIGNED", transaction });
  });
  const broadcast = vi.fn(async () => {
    order.push("broadcast");
    return transaction.hash;
  });
  const operationJournal = journal({
    claim: vi.fn(async () => [financialOperation()]),
    markSigned,
  });
  const transactionGateway = gateway({ broadcast });
  const run = await worker(operationJournal, transactionGateway).runOnce();

  expect(run).toMatchObject({ accepted: 1, signed: 1, submitted: 1 });
  expect(operationJournal.reserveNonce).toHaveBeenCalledWith(
    operationId,
    leaseToken,
    signer,
    transaction.nonce,
  );
  expect(order).toEqual(["signed", "broadcast"]);
  expect(operationJournal.markSubmitted).toHaveBeenCalledWith(operationId, transaction.hash);
});

it("marks a finalized known transaction without signing or broadcasting it again", async () => {
  const signed = financialOperation({
    state: "SUBMITTED",
    leaseOwner: null,
    leaseToken: null,
    leaseUntil: null,
    transaction,
  });
  const operationJournal = journal({ listForReconciliation: vi.fn(async () => [signed]) });
  const transactionGateway = gateway();
  const inspect = vi.fn(async () => ({
    status: "FINALIZED" as const,
    blockNumber: 900n,
    blockHash: `0x${"66".repeat(32)}` as const,
  }));
  const run = await worker(operationJournal, transactionGateway, inspect).runOnce();

  expect(run).toMatchObject({ finalized: 1, accepted: 0 });
  expect(operationJournal.markFinalized).toHaveBeenCalledWith(
    operationId,
    transaction.hash,
    900n,
    `0x${"66".repeat(32)}`,
  );
  expect(transactionGateway.sign).not.toHaveBeenCalled();
  expect(transactionGateway.broadcast).not.toHaveBeenCalled();
});

it("defers an uncertain broadcast instead of rebuilding a signed command", async () => {
  const signed = financialOperation({
    state: "SIGNED",
    leaseOwner: null,
    leaseToken: null,
    leaseUntil: null,
    transaction,
  });
  const operationJournal = journal({ listForReconciliation: vi.fn(async () => [signed]) });
  const transactionGateway = gateway({
    broadcast: vi.fn(async () => {
      throw new Error("network timeout");
    }),
  });
  const run = await worker(
    operationJournal,
    transactionGateway,
    vi.fn(async () => ({ status: "ABSENT" as const })),
  ).runOnce();

  expect(run).toMatchObject({ pending: 1, signed: 0 });
  expect(operationJournal.deferReconciliation).toHaveBeenCalledWith(
    operationId,
    transaction.hash,
    15_000,
    "broadcast_unknown",
  );
  expect(transactionGateway.sign).not.toHaveBeenCalled();
});
