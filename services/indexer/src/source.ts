import { exactPayRouterAbi, resilienceVaultAbi, settlementLedgerAbi } from "@openbalance/protocol";
import {
  type Chain,
  createPublicClient,
  getAddress,
  type Hex,
  http,
  type Log,
  parseAbi,
} from "viem";
import type {
  ConservationSnapshot,
  FinalizedBlock,
  IndexedContracts,
  RawChainLog,
} from "./types.js";

export interface FinalizedChainSource {
  assertManifest(input: {
    chainId: bigint;
    eventId: Hex;
    contracts: IndexedContracts;
  }): Promise<void>;
  getFinalizedHead(): Promise<FinalizedBlock>;
  getLatestHead(): Promise<FinalizedBlock>;
  getBlock(blockNumber: bigint): Promise<FinalizedBlock>;
  getLogs(fromBlock: bigint, toBlock: bigint): Promise<RawChainLog[]>;
  readConservation(blockNumber: bigint): Promise<ConservationSnapshot>;
}

const ledgerBindingAbi = parseAbi([
  "function router() view returns (address)",
  "function vault() view returns (address)",
]);

export type ViemFinalizedChainSourceOptions = {
  rpcUrl: string;
  chain: Chain;
  contracts: IndexedContracts;
  /** Finality policy: public networks use `finalized`; local development chains use `latest`. */
  finalityTag?: "finalized" | "safe" | "latest";
  /** Largest block range per eth_getLogs call; longer requests are split. */
  maxLogRange?: number;
};

export class DeploymentManifestMismatch extends Error {}

function completeLog(log: Log): RawChainLog {
  if (
    log.blockNumber === null ||
    log.blockHash === null ||
    log.transactionHash === null ||
    log.transactionIndex === null ||
    log.logIndex === null
  )
    throw new Error("RPC returned an incomplete finalized log");
  return {
    address: getAddress(log.address),
    data: log.data,
    topics: log.topics as readonly Hex[],
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

export class ViemFinalizedChainSource implements FinalizedChainSource {
  readonly #client;
  readonly #contracts: IndexedContracts;
  readonly #finalityTag: "finalized" | "safe" | "latest";
  readonly #maxLogRange: bigint;

  constructor(options: ViemFinalizedChainSourceOptions) {
    if (!URL.canParse(options.rpcUrl)) throw new Error("Invalid indexer RPC URL");
    this.#finalityTag = options.finalityTag ?? "finalized";
    const maxLogRange = options.maxLogRange ?? 2_000;
    if (!Number.isSafeInteger(maxLogRange) || maxLogRange < 1) throw new Error("Invalid log range");
    this.#maxLogRange = BigInt(maxLogRange);
    this.#contracts = {
      router: getAddress(options.contracts.router),
      ledger: getAddress(options.contracts.ledger),
      vault: getAddress(options.contracts.vault),
    };
    this.#client = createPublicClient({
      chain: options.chain,
      transport: http(options.rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
  }

  async assertManifest(input: {
    chainId: bigint;
    eventId: Hex;
    contracts: IndexedContracts;
  }): Promise<void> {
    const [chainId, routerEventId, vaultEventId, ledgerRouter, ledgerVault] = await Promise.all([
      this.#client.getChainId(),
      this.#client.readContract({
        address: this.#contracts.router,
        abi: exactPayRouterAbi,
        functionName: "eventId",
        blockTag: this.#finalityTag,
      }),
      this.#client.readContract({
        address: this.#contracts.vault,
        abi: resilienceVaultAbi,
        functionName: "eventId",
        blockTag: this.#finalityTag,
      }),
      this.#client.readContract({
        address: this.#contracts.ledger,
        abi: ledgerBindingAbi,
        functionName: "router",
        blockTag: this.#finalityTag,
      }),
      this.#client.readContract({
        address: this.#contracts.ledger,
        abi: ledgerBindingAbi,
        functionName: "vault",
        blockTag: this.#finalityTag,
      }),
    ]);
    if (
      BigInt(chainId) !== input.chainId ||
      routerEventId.toLowerCase() !== input.eventId.toLowerCase() ||
      vaultEventId.toLowerCase() !== input.eventId.toLowerCase() ||
      getAddress(ledgerRouter) !== getAddress(input.contracts.router) ||
      getAddress(ledgerVault) !== getAddress(input.contracts.vault) ||
      getAddress(input.contracts.router) !== this.#contracts.router ||
      getAddress(input.contracts.ledger) !== this.#contracts.ledger ||
      getAddress(input.contracts.vault) !== this.#contracts.vault
    )
      throw new DeploymentManifestMismatch(
        "Indexer deployment manifest does not match finalized contracts",
      );
  }

  async getFinalizedHead(): Promise<FinalizedBlock> {
    const block = await this.#client.getBlock({ blockTag: this.#finalityTag });
    if (block.hash === null) throw new Error("Finalized head has no hash");
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
    };
  }

  async getLatestHead(): Promise<FinalizedBlock> {
    const block = await this.#client.getBlock({ blockTag: "latest" });
    if (block.hash === null) throw new Error("Latest head has no hash");
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
    };
  }

  async getBlock(blockNumber: bigint): Promise<FinalizedBlock> {
    const block = await this.#client.getBlock({ blockNumber });
    if (block.hash === null) throw new Error("Canonical block has no hash");
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
    };
  }

  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<RawChainLog[]> {
    const logs: RawChainLog[] = [];
    // Providers cap eth_getLogs ranges, so a HyperSync-sized batch that falls back is split here.
    for (let from = fromBlock; from <= toBlock; from += this.#maxLogRange) {
      const to = from + this.#maxLogRange - 1n < toBlock ? from + this.#maxLogRange - 1n : toBlock;
      const page = await this.#client.getLogs({
        address: [this.#contracts.router, this.#contracts.ledger, this.#contracts.vault],
        fromBlock: from,
        toBlock: to,
      });
      logs.push(...page.map(completeLog));
    }
    return logs;
  }

  async readConservation(blockNumber: bigint): Promise<ConservationSnapshot> {
    const [ledgerLiabilityUnits, vaultReservedUnits] = await Promise.all([
      this.#client.readContract({
        address: this.#contracts.ledger,
        abi: settlementLedgerAbi,
        functionName: "totalLiability",
        blockNumber,
      }),
      this.#client.readContract({
        address: this.#contracts.vault,
        abi: resilienceVaultAbi,
        functionName: "totalReserved",
        blockNumber,
      }),
    ]);
    return { ledgerLiabilityUnits, vaultReservedUnits };
  }
}
