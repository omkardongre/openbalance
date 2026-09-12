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
  readonly signerAddress: Address;
  readonly #account: PrivateKeyAccount;
  readonly #publicClient;

  constructor(input: { rpcUrl: string; chain: Chain; account: PrivateKeyAccount }) {
    if (!URL.canParse(input.rpcUrl)) throw new Error("Invalid financial transaction RPC URL");
    this.chainId = input.chain.id;
    this.signerAddress = getAddress(input.account.address);
    this.#account = input.account;
    this.#publicClient = createPublicClient({
      chain: input.chain,
      transport: http(input.rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
  }

  async pendingNonce(): Promise<bigint> {
    return BigInt(
      await this.#publicClient.getTransactionCount({
        address: this.signerAddress,
        blockTag: "pending",
      }),
    );
  }

  async simulate(operation: FinancialOperation): Promise<FinancialCommandProposal> {
    try {
      await this.#publicClient.call({
        account: this.signerAddress,
        to: operation.targetAddress,
        data: operation.calldata,
        value: 0n,
      });
      const [estimatedGas, fees] = await Promise.all([
        this.#publicClient.estimateGas({
          account: this.signerAddress,
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
      return {
        gasLimit: (estimatedGas * 120n + 99n) / 100n,
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
  }): Promise<SignedTransaction> {
    if (input.nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new TransientFinancialOperationFailure("nonce_out_of_range");
    const rawTransaction = await this.#account.signTransaction({
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
      signerAddress: this.signerAddress,
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
