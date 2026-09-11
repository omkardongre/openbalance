import type { Address, Hex } from "viem";

export type IndexedContracts = {
  router: Address;
  ledger: Address;
  vault: Address;
};

export type FinalizedBlock = {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
};

export type RawChainLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
};

type TransitionMetadata = {
  transitionId: string;
  chainId: bigint;
  eventId: Hex;
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
};

export type IndexedTransition =
  | (TransitionMetadata & {
      kind: "PAYMENT_COMMITTED";
      paymentId: Hex;
      payer: Address;
      vendorId: Hex;
      configVersion: bigint;
      grossUnits: bigint;
      organizerFeeUnits: bigint;
      platformFeeUnits: bigint;
      receiptCommitment: Hex;
    })
  | (TransitionMetadata & {
      kind: "PAYMENT_CANCELLED";
      paymentId: Hex;
      payer: Address;
    })
  | (TransitionMetadata & {
      kind: "REFUND_COMMITTED";
      refundId: Hex;
      paymentId: Hex;
      payer: Address;
      amountUnits: bigint;
      vendorCreditUnits: bigint;
    })
  | (TransitionMetadata & {
      kind: "CHANNEL_OPENED";
      channelId: Hex;
      originalAccount: Address;
      vendorId: Hex;
      terminalInstanceId: Hex;
      reserveUnits: bigint;
      acceptUntil: number;
      submitUntil: number;
    })
  | (TransitionMetadata & {
      kind: "VOUCHER_SETTLED";
      channelId: Hex;
      paymentId: Hex;
      sequence: number;
      grossUnits: bigint;
      cumulativeGrossUnits: bigint;
      voucherDigest: Hex;
    })
  | (TransitionMetadata & {
      kind: "CHANNEL_RECLAIMED";
      channelId: Hex;
      originalAccount: Address;
      returnedUnits: bigint;
    })
  | (TransitionMetadata & {
      kind: "WITHDRAWN";
      beneficiaryId: Hex;
      destination: Address;
      amountUnits: bigint;
    });

export type IndexerCursor = {
  blockNumber: bigint;
  blockHash: Hex;
};

export type ConservationSnapshot = {
  ledgerLiabilityUnits: bigint;
  vaultReservedUnits: bigint;
};

export type ReconciliationResult = {
  runId: string;
  blockNumber: bigint;
  blockHash: Hex;
  expected: ConservationSnapshot;
  actual: ConservationSnapshot;
  differences: readonly ("LEDGER_LIABILITY" | "VAULT_RESERVED")[];
};
