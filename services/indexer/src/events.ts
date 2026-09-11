import { exactPayRouterAbi, resilienceVaultAbi, settlementLedgerAbi } from "@openbalance/protocol";
import { type Abi, decodeEventLog, getAddress, type Hex } from "viem";
import type { IndexedContracts, IndexedTransition, RawChainLog } from "./types.js";

export class InvalidChainEvent extends Error {}

function asHex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new InvalidChainEvent(`Invalid ${field}`);
  return value as Hex;
}

function asAddress(value: unknown, field: string) {
  if (typeof value !== "string") throw new InvalidChainEvent(`Invalid ${field}`);
  try {
    return getAddress(value);
  } catch {
    throw new InvalidChainEvent(`Invalid ${field}`);
  }
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new InvalidChainEvent(`Invalid ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidChainEvent(`Invalid ${field}`);
  return value;
}

function metadata(log: RawChainLog, chainId: bigint, eventId: Hex) {
  return {
    transitionId: `${chainId}:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`,
    chainId,
    eventId,
    address: getAddress(log.address),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

function decode(log: RawChainLog, abi: Abi): { eventName: string; args: unknown } | null {
  if (log.topics.length === 0) return null;
  try {
    const decoded = decodeEventLog({
      abi,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    if (!decoded.eventName) return null;
    return { eventName: decoded.eventName, args: decoded.args };
  } catch {
    return null;
  }
}

export function decodeIndexedTransition(input: {
  log: RawChainLog;
  chainId: bigint;
  eventId: Hex;
  contracts: IndexedContracts;
}): IndexedTransition | null {
  const { log, chainId, eventId, contracts } = input;
  const address = getAddress(log.address);
  const base = metadata(log, chainId, eventId);

  if (address === getAddress(contracts.router)) {
    const decoded = decode(log, exactPayRouterAbi);
    if (!decoded) return null;
    const args = decoded.args as Record<string, unknown>;
    if (decoded.eventName === "PaymentCommitted") {
      return {
        ...base,
        kind: "PAYMENT_COMMITTED",
        paymentId: asHex(args.paymentId, "payment ID"),
        payer: asAddress(args.payer, "payer"),
        vendorId: asHex(args.vendorId, "vendor ID"),
        configVersion: asBigInt(args.configVersion, "config version"),
        grossUnits: asBigInt(args.gross, "gross units"),
        organizerFeeUnits: asBigInt(args.organizerFee, "organizer fee"),
        platformFeeUnits: asBigInt(args.platformFee, "platform fee"),
        receiptCommitment: asHex(args.receiptCommitment, "receipt commitment"),
      };
    }
    if (decoded.eventName === "PaymentCancelled") {
      return {
        ...base,
        kind: "PAYMENT_CANCELLED",
        paymentId: asHex(args.paymentId, "payment ID"),
        payer: asAddress(args.payer, "payer"),
      };
    }
    if (decoded.eventName === "RefundCommitted") {
      return {
        ...base,
        kind: "REFUND_COMMITTED",
        refundId: asHex(args.refundId, "refund ID"),
        paymentId: asHex(args.paymentId, "payment ID"),
        payer: asAddress(args.payer, "payer"),
        amountUnits: asBigInt(args.amount, "refund amount"),
        vendorCreditUnits: asBigInt(args.vendorCreditUsed, "vendor credit"),
      };
    }
    return null;
  }

  if (address === getAddress(contracts.vault)) {
    const decoded = decode(log, resilienceVaultAbi);
    if (!decoded) return null;
    const args = decoded.args as Record<string, unknown>;
    if (decoded.eventName === "ChannelOpened") {
      return {
        ...base,
        kind: "CHANNEL_OPENED",
        channelId: asHex(args.channelId, "channel ID"),
        originalAccount: asAddress(args.originalAccount, "original account"),
        vendorId: asHex(args.vendorId, "vendor ID"),
        terminalInstanceId: asHex(args.terminalInstanceId, "terminal instance ID"),
        reserveUnits: asBigInt(args.reserveUnits, "reserve units"),
        acceptUntil: asNumber(args.acceptUntil, "accept deadline"),
        submitUntil: asNumber(args.submitUntil, "submission deadline"),
      };
    }
    if (decoded.eventName === "VoucherSettled") {
      return {
        ...base,
        kind: "VOUCHER_SETTLED",
        channelId: asHex(args.channelId, "channel ID"),
        paymentId: asHex(args.paymentId, "payment ID"),
        sequence: asNumber(args.sequence, "voucher sequence"),
        grossUnits: asBigInt(args.grossUnits, "gross units"),
        cumulativeGrossUnits: asBigInt(args.cumulativeGrossUnits, "cumulative gross units"),
        voucherDigest: asHex(args.voucherDigest, "voucher digest"),
      };
    }
    if (decoded.eventName === "ChannelReclaimed") {
      return {
        ...base,
        kind: "CHANNEL_RECLAIMED",
        channelId: asHex(args.channelId, "channel ID"),
        originalAccount: asAddress(args.originalAccount, "original account"),
        returnedUnits: asBigInt(args.returnedUnits, "returned units"),
      };
    }
    return null;
  }

  if (address === getAddress(contracts.ledger)) {
    const decoded = decode(log, settlementLedgerAbi);
    if (decoded?.eventName !== "Withdrawn") return null;
    const args = decoded.args as Record<string, unknown>;
    return {
      ...base,
      kind: "WITHDRAWN",
      beneficiaryId: asHex(args.beneficiaryId, "beneficiary ID"),
      destination: asAddress(args.destination, "withdrawal destination"),
      amountUnits: asBigInt(args.amount, "withdrawal amount"),
    };
  }

  return null;
}

export function sortChainLogs(logs: readonly RawChainLog[]): RawChainLog[] {
  return [...logs].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber)
      return left.blockNumber < right.blockNumber ? -1 : 1;
    if (left.transactionIndex !== right.transactionIndex)
      return left.transactionIndex - right.transactionIndex;
    return left.logIndex - right.logIndex;
  });
}
