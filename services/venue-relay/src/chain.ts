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
};

export class ViemVoucherSettlementGateway implements VoucherSettlementGateway {
  readonly #vault: Address;
  readonly #deploymentBlock: bigint;
  readonly #publicClient;
  readonly #walletClient;
  readonly #account: Account;
  readonly #chain: Chain;

  constructor(options: ViemVoucherSettlementGatewayOptions) {
    if (!URL.canParse(options.rpcUrl) || options.deploymentBlock < 0n)
      throw new Error("Invalid voucher settlement gateway configuration");
    this.#vault = getAddress(options.vault);
    this.#deploymentBlock = options.deploymentBlock;
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
    const finalized = await this.#publicClient.getBlock({ blockTag: "finalized" });
    const logs = await this.#publicClient.getLogs({
      address: this.#vault,
      event: voucherSettledEvent,
      args: { channelId: voucher.channelId, paymentId: voucher.paymentId },
      fromBlock: this.#deploymentBlock,
      toBlock: finalized.number,
      strict: true,
    });
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

  #assertVault(vault: Address): void {
    if (getAddress(vault) !== this.#vault)
      throw new PermanentSettlementFailure("Voucher targets a different vault");
  }
}
