import { resilienceVaultAbi } from "@openbalance/protocol";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  parseAbiItem,
  TransactionReceiptNotFoundError,
} from "viem";
import type { VoucherReceipt } from "./journal.js";
import {
  PermanentSettlementFailure,
  type SettlementObservation,
  type VoucherSettlementGateway,
} from "./settlement.js";
import { decodeVoucher } from "./transport.js";

const voucherSettledEvent = parseAbiItem(
  "event VoucherSettled(bytes32 indexed channelId,bytes32 indexed paymentId,uint32 indexed sequence,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 voucherDigest)",
);

export type ViemVoucherSettlementGatewayOptions = {
  rpcUrl: string;
  chain: Chain;
  account: Account;
  vault: Address;
  deploymentBlock: bigint;
  /** Finality policy: public networks use `finalized`; local development chains use `latest`. */
  finalityTag?: "finalized" | "safe" | "latest";
  /** Most blocks one eth_getLogs call may span; Monad's public RPC allows 1,000. */
  logRangeBlocks?: number;
};

export class ViemVoucherSettlementGateway implements VoucherSettlementGateway {
  readonly #vault: Address;
  readonly #deploymentBlock: bigint;
  readonly #finalityTag: "finalized" | "safe" | "latest";
  readonly #logRange: bigint;
  readonly #blockAt = new Map<bigint, bigint>();
  readonly #publicClient;
  readonly #walletClient;
  readonly #account: Account;
  readonly #chain: Chain;

  constructor(options: ViemVoucherSettlementGatewayOptions) {
    if (!URL.canParse(options.rpcUrl) || options.deploymentBlock < 0n)
      throw new Error("Invalid voucher settlement gateway configuration");
    this.#vault = getAddress(options.vault);
    this.#deploymentBlock = options.deploymentBlock;
    this.#finalityTag = options.finalityTag ?? "finalized";
    const logRange = options.logRangeBlocks ?? 1_000;
    if (!Number.isSafeInteger(logRange) || logRange < 1)
      throw new Error("Invalid voucher settlement gateway configuration");
    this.#logRange = BigInt(logRange);
    this.#account = options.account;
    this.#chain = options.chain;
    this.#publicClient = createPublicClient({
      chain: options.chain,
      transport: http(options.rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
    this.#walletClient = createWalletClient({
      chain: options.chain,
      transport: http(options.rpcUrl),
    });
  }

  async reconcile(
    receipt: VoucherReceipt,
    transactionHash: Hex | null,
  ): Promise<SettlementObservation> {
    const voucher = decodeVoucher(receipt);
    this.#assertVault(voucher.vault);
    const finalized = await this.#publicClient.getBlock({ blockTag: this.#finalityTag });
    // The vault accepts this voucher only at or after `acceptedAt` and before `submitUntil`, so its
    // settlement event can only sit in the blocks of that window. Public RPCs cap the range of a
    // single eth_getLogs call (Monad's public endpoint at 1,000 blocks), so the window is read in
    // chunks rather than from the deployment block in one call, which such an endpoint rejects.
    const fromBlock = await this.#firstBlockAtOrAfter(
      BigInt(voucher.acceptedAt),
      this.#deploymentBlock,
      finalized,
    );
    const submitBound = await this.#firstBlockAtOrAfter(
      BigInt(voucher.submitUntil),
      fromBlock,
      finalized,
    );
    const toBlock = submitBound < finalized.number ? submitBound : finalized.number;
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += this.#logRange) {
      const end = start + this.#logRange - 1n < toBlock ? start + this.#logRange - 1n : toBlock;
      logs.push(
        ...(await this.#publicClient.getLogs({
          address: this.#vault,
          event: voucherSettledEvent,
          args: { channelId: voucher.channelId, paymentId: voucher.paymentId },
          fromBlock: start,
          toBlock: end,
          strict: true,
        })),
      );
    }
    if (logs.length > 1)
      throw new PermanentSettlementFailure("Multiple finalized voucher records found");
    const [log] = logs;
    if (log) {
      if (
        log.args.sequence !== voucher.sequence ||
        log.args.grossUnits !== voucher.grossUnits ||
        log.args.cumulativeGrossUnits !== voucher.cumulativeGrossUnits
      )
        throw new PermanentSettlementFailure("Finalized voucher record does not match receipt");
      return { status: "SETTLED", transactionHash: log.transactionHash };
    }
    if (!transactionHash) return { status: "ABSENT" };
    try {
      const transaction = await this.#publicClient.getTransactionReceipt({ hash: transactionHash });
      if (transaction.blockNumber > finalized.number) return { status: "PENDING", transactionHash };
      return {
        status: "REJECTED",
        transactionHash,
        reason:
          transaction.status === "reverted"
            ? "Voucher settlement transaction reverted"
            : "Finalized transaction omitted the expected voucher event",
      };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError)
        return { status: "PENDING", transactionHash };
      throw error;
    }
  }

  async submit(receipt: VoucherReceipt): Promise<{ transactionHash: Hex }> {
    const voucher = decodeVoucher(receipt);
    this.#assertVault(voucher.vault);
    const { request } = await this.#publicClient.simulateContract({
      account: this.#account,
      address: this.#vault,
      abi: resilienceVaultAbi,
      functionName: "settleVoucher",
      args: [voucher, receipt.attendeeSignature as Hex, receipt.terminalSignature as Hex],
    });
    const transactionHash = await this.#walletClient.writeContract({
      ...request,
      account: this.#account,
      chain: this.#chain,
    });
    return { transactionHash };
  }

  /**
   * The first block in [lower, finalized] whose timestamp is at least `timestamp`, or the finalized
   * block when none is. Block timestamps never decrease, so a binary search suffices; results are
   * cached because they never change once finalized.
   */
  async #firstBlockAtOrAfter(
    timestamp: bigint,
    lower: bigint,
    finalized: { number: bigint; timestamp: bigint },
  ): Promise<bigint> {
    if (finalized.timestamp < timestamp) return finalized.number;
    const cached = this.#blockAt.get(timestamp);
    if (cached !== undefined && cached >= lower && cached <= finalized.number) return cached;
    let low = lower;
    let high = finalized.number;
    while (low < high) {
      const middle = (low + high) / 2n;
      const block = await this.#publicClient.getBlock({ blockNumber: middle });
      if (block.timestamp < timestamp) low = middle + 1n;
      else high = middle;
    }
    this.#blockAt.set(timestamp, low);
    return low;
  }

  #assertVault(vault: Address): void {
    if (getAddress(vault) !== this.#vault)
      throw new PermanentSettlementFailure("Voucher targets a different vault");
  }
}
