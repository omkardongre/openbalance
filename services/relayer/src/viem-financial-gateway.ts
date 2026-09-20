import {
  type Address,
  type Chain,
  createPublicClient,
  getAddress,
  type Hex,
  http,
  keccak256,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { FinancialOperation, SignedTransaction } from "./financial-operations.js";
import {
  type FinancialCommandProposal,
  type FinancialTransactionGateway,
  TransientFinancialOperationFailure,
} from "./financial-worker.js";

export class ViemFinancialTransactionGateway implements FinancialTransactionGateway {
  readonly chainId: number;
  readonly signerAddresses: readonly Address[];
  readonly #accounts: ReadonlyMap<string, PrivateKeyAccount>;
  readonly #publicClient;
  readonly #gasLimitMarginBps: bigint;
  readonly #reserveBalanceWei: bigint;
  readonly #finalityTag: "finalized" | "safe" | "latest";

  constructor(input: {
    rpcUrl: string;
    chain: Chain;
    accounts: readonly PrivateKeyAccount[];
    gasLimitMarginBps: number;
    reserveBalanceWei: bigint;
    finalityTag: "finalized" | "safe" | "latest";
  }) {
    if (!URL.canParse(input.rpcUrl)) throw new Error("Invalid financial transaction RPC URL");
    if (input.accounts.length === 0) throw new Error("No financial signing keys configured");
    if (
      !Number.isSafeInteger(input.gasLimitMarginBps) ||
      input.gasLimitMarginBps < 0 ||
      input.gasLimitMarginBps > 5_000
    )
      throw new Error("Invalid financial gas limit margin");
    if (input.reserveBalanceWei < 0n) throw new Error("Invalid financial reserve balance");
    const accounts = new Map(
      input.accounts.map((account) => [getAddress(account.address).toLowerCase(), account]),
    );
    if (accounts.size !== input.accounts.length)
      throw new Error("Duplicate financial signing key configured");
    this.chainId = input.chain.id;
    this.signerAddresses = input.accounts.map((account) => getAddress(account.address));
    this.#accounts = accounts;
    this.#gasLimitMarginBps = BigInt(input.gasLimitMarginBps);
    this.#reserveBalanceWei = input.reserveBalanceWei;
    this.#finalityTag = input.finalityTag;
    this.#publicClient = createPublicClient({
      chain: input.chain,
      transport: http(input.rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
  }

  #account(signerAddress: Address): PrivateKeyAccount {
    const account = this.#accounts.get(getAddress(signerAddress).toLowerCase());
    if (!account) throw new TransientFinancialOperationFailure("unknown_signing_key");
    return account;
  }

  async pendingNonce(signerAddress: Address): Promise<bigint> {
    return BigInt(
      await this.#publicClient.getTransactionCount({
        address: getAddress(signerAddress),
        blockTag: "pending",
      }),
    );
  }

  /**
   * The chain caps the summed gas spend of one account's inflight transactions at the lower of a
   * fixed per-account reserve and the account's own balance, judged against a lagged execution
   * state. The balance is therefore read at the configured finality tag rather than at `latest`, so
   * the figure cannot be more current than the state consensus actually decides against.
   */
  async inflightGasBudget(signerAddress: Address): Promise<bigint | null> {
    if (this.#reserveBalanceWei === 0n) return null;
    try {
      const balance = await this.#publicClient.getBalance({
        address: getAddress(signerAddress),
        blockTag: this.#finalityTag,
      });
      return balance < this.#reserveBalanceWei ? balance : this.#reserveBalanceWei;
    } catch {
      throw new TransientFinancialOperationFailure("signer_balance_unavailable");
    }
  }

  async simulate(operation: FinancialOperation): Promise<FinancialCommandProposal> {
    // Simulated from the first key purely to obtain a gas estimate; the estimate does not depend on
    // which pool key eventually signs, and the key is only chosen later under the budget lock.
    const estimator = this.signerAddresses[0];
    if (!estimator) throw new TransientFinancialOperationFailure("unknown_signing_key");
    try {
      await this.#publicClient.call({
        account: estimator,
        to: operation.targetAddress,
        data: operation.calldata,
        value: 0n,
      });
      const [estimatedGas, fees] = await Promise.all([
        this.#publicClient.estimateGas({
          account: estimator,
          to: operation.targetAddress,
          data: operation.calldata,
          value: 0n,
        }),
        this.#publicClient.estimateFeesPerGas({ type: "eip1559" }),
      ]);
      if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined)
        throw new TransientFinancialOperationFailure(
          "eip1559_fees_unavailable",
          "Network did not return EIP-1559 fee data",
        );
      // Gas is charged on the declared limit with no refund, so this margin is spent whether or not
      // it is used, and it also occupies inflight budget that would otherwise admit another
      // transaction. It stays small for that reason and is calibrated, not a fixed safety buffer.
      const denominator = 10_000n;
      return {
        gasLimit:
          (estimatedGas * (denominator + this.#gasLimitMarginBps) + denominator - 1n) / denominator,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    } catch (error) {
      if (error instanceof TransientFinancialOperationFailure) throw error;
      throw new TransientFinancialOperationFailure("simulation_unavailable");
    }
  }

  async sign(input: {
    operation: FinancialOperation;
    nonce: bigint;
    proposal: FinancialCommandProposal;
    signerAddress: Address;
  }): Promise<SignedTransaction> {
    if (input.nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TransientFinancialOperationFailure("nonce_out_of_range");
    const account = this.#account(input.signerAddress);
    const rawTransaction = await account.signTransaction({
      chainId: this.chainId,
      type: "eip1559",
      to: input.operation.targetAddress,
      data: input.operation.calldata,
      value: 0n,
      gas: input.proposal.gasLimit,
      nonce: Number(input.nonce),
      maxFeePerGas: input.proposal.maxFeePerGas,
      maxPriorityFeePerGas: input.proposal.maxPriorityFeePerGas,
    });
    return {
      signerAddress: getAddress(account.address),
      nonce: input.nonce,
      hash: keccak256(rawTransaction),
      rawTransaction,
      ...input.proposal,
    };
  }

  async broadcast(rawTransaction: Hex): Promise<Hex> {
    return this.#publicClient.sendRawTransaction({ serializedTransaction: rawTransaction });
  }
}
