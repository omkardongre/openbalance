import {
  accountAbi,
  decodePaymentIntent,
  exactPayRouterAbi,
  type PaymentIntent,
  resilienceVaultAbi,
  settlementLedgerAbi,
  validateRefundIntent,
  validateReserveChannelConfig,
} from "@openbalance/protocol";
import {
  type Abi,
  type Address,
  type Chain,
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  type Hex,
  http,
  TransactionReceiptNotFoundError,
} from "viem";
import type { FinancialOperation } from "./financial-operations.js";
import {
  type FinancialFinalityObservation,
  type FinancialFinalityVerifier,
  FinancialOperationIntegrityFailure,
  TransientFinancialOperationFailure,
} from "./financial-worker.js";

type ExpectedEvent = {
  address: Address;
  abi: Abi;
  name: string;
  eventId?: Hex;
  asset?: Address;
  matches(args: Record<string, unknown>): boolean;
};

const equalHex = (left: unknown, right: Hex) =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();
const equalAddress = (left: unknown, right: Address) => {
  if (typeof left !== "string") return false;
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
};

function accountPayment(operation: FinancialOperation) {
  let decoded: ReturnType<typeof decodeFunctionData<typeof accountAbi>>;
  try {
    decoded = decodeFunctionData({ abi: accountAbi, data: operation.calldata });
  } catch {
    throw new FinancialOperationIntegrityFailure("invalid_account_command");
  }
  if (
    decoded.functionName !== "pay" &&
    decoded.functionName !== "payWithOnlineSession" &&
    decoded.functionName !== "cancelPayment"
  )
    throw new FinancialOperationIntegrityFailure("unexpected_account_command");
  let intent: PaymentIntent;
  try {
    intent = decodePaymentIntent(decoded.args[1]);
  } catch {
    throw new FinancialOperationIntegrityFailure("invalid_payment_intent");
  }
  if (!equalHex(intent.paymentId, operation.aggregateId))
    throw new FinancialOperationIntegrityFailure("aggregate_mismatch");
  return intent;
}

export function expectedFinancialEvent(operation: FinancialOperation): ExpectedEvent {
  if (operation.kind === "PAYMENT") {
    const intent = accountPayment(operation);
    return {
      address: getAddress(intent.router),
      abi: exactPayRouterAbi,
      name: "PaymentCommitted",
      eventId: intent.eventId,
      asset: getAddress(intent.asset),
      matches: (args) =>
        equalHex(args.paymentId, intent.paymentId) &&
        equalAddress(args.payer, operation.targetAddress) &&
        equalHex(args.vendorId, intent.vendorId) &&
        args.gross === intent.grossUnits &&
        equalHex(args.receiptCommitment, intent.receiptCommitment),
    };
  }
  if (operation.kind === "CANCELLATION") {
    const intent = accountPayment(operation);
    return {
      address: getAddress(intent.router),
      abi: exactPayRouterAbi,
      name: "PaymentCancelled",
      eventId: intent.eventId,
      asset: getAddress(intent.asset),
      matches: (args) =>
        equalHex(args.paymentId, intent.paymentId) &&
        equalAddress(args.payer, operation.targetAddress),
    };
  }
  if (operation.kind === "RESERVE_OPEN") {
    let decoded: ReturnType<typeof decodeFunctionData<typeof accountAbi>>;
    try {
      decoded = decodeFunctionData({ abi: accountAbi, data: operation.calldata });
    } catch {
      throw new FinancialOperationIntegrityFailure("invalid_reserve_command");
    }
    if (decoded.functionName !== "openReserveChannel")
      throw new FinancialOperationIntegrityFailure("unexpected_reserve_command");
    const [vault, config] = decoded.args;
    try {
      validateReserveChannelConfig(config);
    } catch {
      throw new FinancialOperationIntegrityFailure("invalid_reserve_terms");
    }
    if (!equalHex(config.channelId, operation.aggregateId))
      throw new FinancialOperationIntegrityFailure("aggregate_mismatch");
    return {
      address: getAddress(vault),
      abi: resilienceVaultAbi,
      name: "ChannelOpened",
      eventId: config.eventId,
      asset: getAddress(config.asset),
      matches: (args) =>
        equalHex(args.channelId, config.channelId) &&
        equalAddress(args.originalAccount, operation.targetAddress) &&
        equalHex(args.vendorId, config.vendorId) &&
        equalHex(args.terminalInstanceId, config.terminalInstanceId) &&
        args.reserveUnits === config.reserveUnits &&
        args.acceptUntil === config.acceptUntil &&
        args.submitUntil === config.submitUntil,
    };
  }
  if (operation.kind === "REFUND") {
    let decoded: ReturnType<typeof decodeFunctionData<typeof exactPayRouterAbi>>;
    try {
      decoded = decodeFunctionData({ abi: exactPayRouterAbi, data: operation.calldata });
    } catch {
      throw new FinancialOperationIntegrityFailure("invalid_refund_command");
    }
    if (decoded.functionName !== "refund")
      throw new FinancialOperationIntegrityFailure("unexpected_refund_command");
    const [intent] = decoded.args;
    try {
      validateRefundIntent(intent);
    } catch {
      throw new FinancialOperationIntegrityFailure("invalid_refund_terms");
    }
    if (!equalHex(intent.refundId, operation.aggregateId))
      throw new FinancialOperationIntegrityFailure("aggregate_mismatch");
    return {
      address: getAddress(operation.targetAddress),
      abi: exactPayRouterAbi,
      name: "RefundCommitted",
      eventId: intent.eventId,
      asset: getAddress(intent.asset),
      matches: (args) =>
        equalHex(args.refundId, intent.refundId) &&
        equalHex(args.paymentId, intent.paymentId) &&
        equalAddress(args.payer, intent.payerAccount) &&
        args.amount === intent.refundUnits &&
        args.vendorCreditUsed === intent.vendorCreditUnits,
    };
  }
  if (operation.kind === "RESERVE_RECLAIM") {
    let decoded: ReturnType<typeof decodeFunctionData<typeof resilienceVaultAbi>>;
    try {
      decoded = decodeFunctionData({ abi: resilienceVaultAbi, data: operation.calldata });
    } catch {
      throw new FinancialOperationIntegrityFailure("invalid_reclaim_command");
    }
    if (decoded.functionName !== "reclaim" || !equalHex(decoded.args[0], operation.aggregateId))
      throw new FinancialOperationIntegrityFailure("unexpected_reclaim_command");
    return {
      address: getAddress(operation.targetAddress),
      abi: resilienceVaultAbi,
      name: "ChannelReclaimed",
      matches: (args) => equalHex(args.channelId, operation.aggregateId),
    };
  }
  let decoded: ReturnType<typeof decodeFunctionData<typeof settlementLedgerAbi>>;
  try {
    decoded = decodeFunctionData({ abi: settlementLedgerAbi, data: operation.calldata });
  } catch {
    throw new FinancialOperationIntegrityFailure("invalid_withdrawal_command");
  }
  if (decoded.functionName !== "withdrawFor" || !equalHex(decoded.args[0], operation.aggregateId))
    throw new FinancialOperationIntegrityFailure("unexpected_withdrawal_command");
  return {
    address: getAddress(operation.targetAddress),
    abi: settlementLedgerAbi,
    name: "Withdrawn",
    matches: (args) => equalHex(args.beneficiaryId, operation.aggregateId),
  };
}

export class ViemFinancialFinalityVerifier implements FinancialFinalityVerifier {
  readonly #client;

  constructor(input: { rpcUrl: string; chain: Chain }) {
    if (!URL.canParse(input.rpcUrl)) throw new Error("Invalid financial finality RPC URL");
    this.#client = createPublicClient({
      chain: input.chain,
      transport: http(input.rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
  }

  async inspect(operation: FinancialOperation): Promise<FinancialFinalityObservation> {
    if (!operation.transaction)
      throw new FinancialOperationIntegrityFailure("missing_signed_transaction");
    const expected = expectedFinancialEvent(operation);
    try {
      const [receipt, finalized] = await Promise.all([
        this.#client.getTransactionReceipt({ hash: operation.transaction.hash }),
        this.#client.getBlock({ blockTag: "finalized" }),
      ]);
      if (receipt.blockNumber > finalized.number) return { status: "PENDING" };
      const canonical = await this.#client.getBlock({ blockNumber: receipt.blockNumber });
      if (
        canonical.hash === null ||
        canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
      )
        throw new FinancialOperationIntegrityFailure("finalized_block_mismatch");
      if (receipt.status === "reverted")
        return { status: "REVERTED", code: "transaction_reverted" };
      const matches = receipt.logs.filter((log) => {
        if (getAddress(log.address) !== expected.address || log.topics.length === 0) return false;
        try {
          const decoded = decodeEventLog({
            abi: expected.abi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
          return (
            decoded.eventName === expected.name &&
            expected.matches(decoded.args as unknown as Record<string, unknown>)
          );
        } catch {
          return false;
        }
      });
      if (matches.length !== 1)
        throw new FinancialOperationIntegrityFailure(
          matches.length === 0 ? "expected_event_missing" : "duplicate_expected_event",
        );
      return {
        status: "FINALIZED",
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return { status: "ABSENT" };
      if (error instanceof FinancialOperationIntegrityFailure) throw error;
      throw new TransientFinancialOperationFailure("finality_rpc_unavailable");
    }
  }
}
