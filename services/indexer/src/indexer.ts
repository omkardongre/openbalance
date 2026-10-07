import type { Hex } from "viem";
import { MAXIMUM_HYPERSYNC_BATCH } from "./config.js";
import { decodeIndexedTransition, sortChainLogs } from "./events.js";
import type { FinalizedChainSource } from "./source.js";
import type { IndexerStore } from "./store.js";
import type { IndexedContracts } from "./types.js";

export class FinalizedHistoryConflict extends Error {}

export type FinalizedIndexerOptions = {
  streamId: string;
  chainId: bigint;
  eventId: Hex;
  contracts: IndexedContracts;
  deploymentBlock: bigint;
  batchSize: number;
  source: FinalizedChainSource;
  store: IndexerStore;
};

export type IndexRunResult = {
  fromBlock: bigint | null;
  toBlock: bigint | null;
  transitionCount: number;
  finalizedHead: bigint;
  caughtUp: boolean;
};

export class FinalizedIndexer {
  readonly #options: FinalizedIndexerOptions;
  #manifestVerified = false;

  constructor(options: FinalizedIndexerOptions) {
    if (
      !/^[a-z0-9:_-]{1,256}$/i.test(options.streamId) ||
      options.chainId <= 0n ||
      options.deploymentBlock < 0n ||
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > MAXIMUM_HYPERSYNC_BATCH
    )
      throw new Error("Invalid finalized indexer configuration");
    this.#options = options;
  }

  async runOnce(): Promise<IndexRunResult> {
    if (!this.#manifestVerified) {
      await this.#options.source.assertManifest({
        chainId: this.#options.chainId,
        eventId: this.#options.eventId,
        contracts: this.#options.contracts,
      });
      this.#manifestVerified = true;
    }
    const cursor = await this.#options.store.getCursor(this.#options.streamId);
    if (cursor) {
      const canonical = await this.#options.source.getBlock(cursor.blockNumber);
      if (canonical.hash.toLowerCase() !== cursor.blockHash.toLowerCase()) {
        const message = `Finalized cursor hash disagrees at block ${cursor.blockNumber}`;
        await this.#options.store.recordIntegrityIncident({
          streamId: this.#options.streamId,
          blockNumber: cursor.blockNumber,
          expectedBlockHash: cursor.blockHash,
          observedBlockHash: canonical.hash,
          code: "FINALIZED_HISTORY_CONTRADICTION",
          message,
        });
        throw new FinalizedHistoryConflict(message);
      }
    }

    const finalized = await this.#options.source.getFinalizedHead();
    if (cursor && finalized.number < cursor.blockNumber) {
      const message = `Finalized head moved behind cursor ${cursor.blockNumber}`;
      await this.#options.store.recordIntegrityIncident({
        streamId: this.#options.streamId,
        code: "FINALIZED_HISTORY_CONTRADICTION",
        blockNumber: cursor.blockNumber,
        expectedBlockHash: cursor.blockHash,
        observedBlockHash: finalized.hash,
        message,
      });
      throw new FinalizedHistoryConflict(message);
    }
    const fromBlock = cursor ? cursor.blockNumber + 1n : this.#options.deploymentBlock;
    if (fromBlock > finalized.number)
      return {
        fromBlock: null,
        toBlock: null,
        transitionCount: 0,
        finalizedHead: finalized.number,
        caughtUp: true,
      };

    const upperBound = fromBlock + BigInt(this.#options.batchSize - 1);
    const toBlock = upperBound < finalized.number ? upperBound : finalized.number;
    const endBlock =
      toBlock === finalized.number ? finalized : await this.#options.source.getBlock(toBlock);
    const rawLogs = sortChainLogs(await this.#options.source.getLogs(fromBlock, toBlock));
    const canonicalHashes = new Map<string, string>();
    for (const log of rawLogs) {
      const key = log.blockNumber.toString();
      let canonicalHash = canonicalHashes.get(key);
      if (!canonicalHash) {
        canonicalHash = (await this.#options.source.getBlock(log.blockNumber)).hash.toLowerCase();
        canonicalHashes.set(key, canonicalHash);
      }
      if (canonicalHash !== log.blockHash.toLowerCase()) {
        const message = `Finalized log hash disagrees at block ${log.blockNumber}`;
        await this.#options.store.recordIntegrityIncident({
          streamId: this.#options.streamId,
          code: "FINALIZED_HISTORY_CONTRADICTION",
          blockNumber: log.blockNumber,
          expectedBlockHash: log.blockHash,
          observedBlockHash: canonicalHash as Hex,
          message,
        });
        throw new FinalizedHistoryConflict(message);
      }
    }
    const transitions = rawLogs.flatMap((log) => {
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock)
        throw new Error("RPC returned a log outside the requested block range");
      const transition = decodeIndexedTransition({
        log,
        chainId: this.#options.chainId,
        eventId: this.#options.eventId,
        contracts: this.#options.contracts,
      });
      return transition ? [transition] : [];
    });
    await this.#options.store.commitFinalizedBatch({
      streamId: this.#options.streamId,
      chainId: this.#options.chainId,
      deploymentBlock: this.#options.deploymentBlock,
      fromBlock,
      toBlock,
      endBlockHash: endBlock.hash,
      transitions,
    });
    return {
      fromBlock,
      toBlock,
      transitionCount: transitions.length,
      finalizedHead: finalized.number,
      caughtUp: toBlock === finalized.number,
    };
  }
}
