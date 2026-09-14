import type { Hex } from "viem";
import { decodeIndexedTransition, sortChainLogs } from "./events.js";
import type { FinalizedChainSource } from "./source.js";
import type { IndexedContracts, IndexedTransition, IndexerCursor } from "./types.js";

export type ProvisionalBlock = {
  blockNumber: bigint;
  blockHash: Hex;
  parentHash: Hex;
};

export interface ProvisionalStore {
  getFinalizedCursor(streamId: string): Promise<IndexerCursor | null>;
  getProvisionalCursor(streamId: string): Promise<IndexerCursor | null>;
  getProvisionalBlock(streamId: string, blockNumber: bigint): Promise<ProvisionalBlock | null>;
  replaceProvisionalTail(input: {
    streamId: string;
    chainId: bigint;
    eventId: Hex;
    ancestorBlock: bigint | null;
    blocks: readonly ProvisionalBlock[];
    transitions: readonly IndexedTransition[];
  }): Promise<void>;
  verifyFinalizedBoundary(input: {
    streamId: string;
    blockNumber: bigint;
    blockHash: Hex;
  }): Promise<void>;
}

export type ProvisionalIndexerOptions = {
  streamId: string;
  chainId: bigint;
  eventId: Hex;
  contracts: IndexedContracts;
  deploymentBlock: bigint;
  batchSize: number;
  maximumReorgDepth: number;
  source: FinalizedChainSource;
  store: ProvisionalStore;
};

export class ProvisionalReorgTooDeep extends Error {}

export class ProvisionalIndexer {
  readonly #options: ProvisionalIndexerOptions;

  constructor(options: ProvisionalIndexerOptions) {
    if (
      options.maximumReorgDepth < 1 ||
      options.maximumReorgDepth > 512 ||
      options.batchSize < 1 ||
      options.batchSize > 2_000
    )
      throw new Error("Invalid provisional indexer configuration");
    this.#options = options;
  }

  async runOnce() {
    const latest = await this.#options.source.getLatestHead();
    const finalized = await this.#options.store.getFinalizedCursor(this.#options.streamId);
    let cursor = await this.#options.store.getProvisionalCursor(this.#options.streamId);
    let ancestorBlock: bigint | null = cursor?.blockNumber ?? null;
    let rewound = 0;

    while (cursor) {
      const canonical = await this.#options.source.getBlock(cursor.blockNumber);
      if (canonical.hash.toLowerCase() === cursor.blockHash.toLowerCase()) break;
      rewound += 1;
      if (rewound > this.#options.maximumReorgDepth)
        throw new ProvisionalReorgTooDeep(
          "Provisional reorganization exceeds the configured bound",
        );
      const previous = cursor.blockNumber - 1n;
      if (previous < this.#options.deploymentBlock) {
        cursor = null;
        ancestorBlock = null;
      } else {
        const stored = await this.#options.store.getProvisionalBlock(
          this.#options.streamId,
          previous,
        );
        cursor = stored ? { blockNumber: stored.blockNumber, blockHash: stored.blockHash } : null;
        ancestorBlock = cursor?.blockNumber ?? null;
      }
    }

    const fromBlock = cursor ? cursor.blockNumber + 1n : this.#options.deploymentBlock;
    if (fromBlock > latest.number) {
      if (finalized && finalized.blockNumber >= this.#options.deploymentBlock)
        await this.#options.store.verifyFinalizedBoundary({
          streamId: this.#options.streamId,
          blockNumber: finalized.blockNumber,
          blockHash: finalized.blockHash,
        });
      return { fromBlock: null, toBlock: null, transitionCount: 0, rewound, caughtUp: true };
    }

    const upper = fromBlock + BigInt(this.#options.batchSize - 1);
    const toBlock = upper < latest.number ? upper : latest.number;
    const blocks: ProvisionalBlock[] = [];
    for (let number = fromBlock; number <= toBlock; number += 1n) {
      const block = number === latest.number ? latest : await this.#options.source.getBlock(number);
      const previous = blocks.at(-1);
      if (!previous && cursor && block.parentHash.toLowerCase() !== cursor.blockHash.toLowerCase())
        throw new Error("RPC returned a provisional block outside the retained canonical tail");
      if (previous && block.parentHash.toLowerCase() !== previous.blockHash.toLowerCase())
        throw new Error("RPC returned a discontinuous provisional block range");
      blocks.push({ blockNumber: number, blockHash: block.hash, parentHash: block.parentHash });
    }
    const hashes = new Map(blocks.map((block) => [block.blockNumber.toString(), block.blockHash]));
    const logs = sortChainLogs(await this.#options.source.getLogs(fromBlock, toBlock));
    const transitions = logs.flatMap((log) => {
      if (hashes.get(log.blockNumber.toString())?.toLowerCase() !== log.blockHash.toLowerCase())
        throw new Error("Provisional log does not match its canonical block");
      const transition = decodeIndexedTransition({
        log,
        chainId: this.#options.chainId,
        eventId: this.#options.eventId,
        contracts: this.#options.contracts,
      });
      return transition ? [transition] : [];
    });
    await this.#options.store.replaceProvisionalTail({
      streamId: this.#options.streamId,
      chainId: this.#options.chainId,
      eventId: this.#options.eventId,
      ancestorBlock,
      blocks,
      transitions,
    });
    if (finalized && finalized.blockNumber >= this.#options.deploymentBlock)
      await this.#options.store.verifyFinalizedBoundary({
        streamId: this.#options.streamId,
        blockNumber: finalized.blockNumber,
        blockHash: finalized.blockHash,
      });
    return {
      fromBlock,
      toBlock,
      transitionCount: transitions.length,
      rewound,
      caughtUp: toBlock === latest.number,
    };
  }
}
