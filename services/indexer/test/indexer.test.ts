import { exactPayRouterAbi } from "@openbalance/protocol";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { expect, it } from "vitest";
import { decodeIndexedTransition } from "../src/events.js";
import { FinalizedHistoryConflict, FinalizedIndexer } from "../src/indexer.js";
import { ConservationReconciler } from "../src/reconciliation.js";
import type { FinalizedChainSource } from "../src/source.js";
import type { FinalizedBatch, IndexerStore, IntegrityIncidentInput } from "../src/store.js";
import type {
  ConservationSnapshot,
  FinalizedBlock,
  IndexedTransition,
  IndexerCursor,
  RawChainLog,
  ReconciliationResult,
} from "../src/types.js";

const hex32 = (nibble: string) => `0x${nibble.repeat(64)}` as Hex;
const contracts = {
  router: "0x1111111111111111111111111111111111111111",
  ledger: "0x2222222222222222222222222222222222222222",
  vault: "0x3333333333333333333333333333333333333333",
} as const;
const eventId = hex32("e");

function paymentLog(): RawChainLog {
  const paymentId = hex32("4");
  const payer = "0x5555555555555555555555555555555555555555";
  const vendorId = hex32("6");
  const topics = encodeEventTopics({
    abi: exactPayRouterAbi,
    eventName: "PaymentCommitted",
    args: { paymentId, payer, vendorId },
  });
  if (topics.some((topic) => topic === null)) throw new Error("Incomplete payment topics");
  return {
    address: contracts.router,
    topics: topics as readonly Hex[],
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [1n, 100n, 2n, 1n, hex32("7")],
    ),
    blockNumber: 11n,
    blockHash: hex32("b"),
    transactionHash: hex32("c"),
    transactionIndex: 2,
    logIndex: 3,
  };
}

class MemoryStore implements IndexerStore {
  cursor: IndexerCursor | null = null;
  snapshot: ConservationSnapshot = { ledgerLiabilityUnits: 0n, vaultReservedUnits: 0n };
  batches: FinalizedBatch[] = [];
  incidents: IntegrityIncidentInput[] = [];
  reconciliations: ReconciliationResult[] = [];

  async getCursor() {
    return this.cursor;
  }

  async commitFinalizedBatch(batch: FinalizedBatch) {
    this.batches.push(batch);
    for (const transition of batch.transitions) this.#apply(transition);
    this.cursor = { blockNumber: batch.toBlock, blockHash: batch.endBlockHash };
  }

  async getExpectedConservation() {
    return this.cursor ? { cursor: this.cursor, snapshot: this.snapshot } : null;
  }

  async recordReconciliation(result: ReconciliationResult) {
    this.reconciliations.push(result);
  }

  async recordIntegrityIncident(incident: IntegrityIncidentInput) {
    this.incidents.push(incident);
  }

  #apply(transition: IndexedTransition) {
    if (transition.kind === "PAYMENT_COMMITTED")
      this.snapshot = {
        ...this.snapshot,
        ledgerLiabilityUnits: this.snapshot.ledgerLiabilityUnits + transition.grossUnits,
      };
  }
}

class MemorySource implements FinalizedChainSource {
  canonicalHash = hex32("d");
  actual: ConservationSnapshot = { ledgerLiabilityUnits: 100n, vaultReservedUnits: 0n };

  constructor(readonly logs: RawChainLog[]) {}

  async assertManifest() {}

  async getFinalizedHead(): Promise<FinalizedBlock> {
    return this.#block(12n, this.canonicalHash);
  }

  async getBlock(blockNumber: bigint): Promise<FinalizedBlock> {
    return this.#block(blockNumber, blockNumber === 11n ? hex32("b") : this.canonicalHash);
  }

  async getLogs(fromBlock: bigint, toBlock: bigint) {
    return this.logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  }

  async readConservation() {
    return this.actual;
  }

  #block(number: bigint, hash: Hex): FinalizedBlock {
    return { number, hash, parentHash: hex32("a"), timestamp: 1_000n };
  }
}

function createIndexer(source: MemorySource, store: MemoryStore) {
  return new FinalizedIndexer({
    streamId: "test:10143:event",
    chainId: 10_143n,
    eventId,
    contracts,
    deploymentBlock: 10n,
    batchSize: 100,
    source,
    store,
  });
}

it("decodes a canonical payment event into exact integer units", () => {
  const transition = decodeIndexedTransition({
    log: paymentLog(),
    chainId: 10_143n,
    eventId,
    contracts,
  });
  expect(transition).toMatchObject({
    kind: "PAYMENT_COMMITTED",
    grossUnits: 100n,
    organizerFeeUnits: 2n,
    platformFeeUnits: 1n,
    blockNumber: 11n,
  });
});

it("advances one finalized cursor and stops on a later hash contradiction", async () => {
  const source = new MemorySource([paymentLog()]);
  const store = new MemoryStore();
  const indexer = createIndexer(source, store);
  await expect(indexer.runOnce()).resolves.toMatchObject({
    fromBlock: 10n,
    toBlock: 12n,
    transitionCount: 1,
    caughtUp: true,
  });
  expect(store.snapshot.ledgerLiabilityUnits).toBe(100n);

  source.canonicalHash = hex32("f");
  await expect(indexer.runOnce()).rejects.toThrow(FinalizedHistoryConflict);
  expect(store.incidents).toHaveLength(1);
  expect(store.incidents[0]?.code).toBe("FINALIZED_HISTORY_CONTRADICTION");
});

it("records exact-block conservation differences without changing projections", async () => {
  const source = new MemorySource([paymentLog()]);
  const store = new MemoryStore();
  await createIndexer(source, store).runOnce();
  source.actual = { ledgerLiabilityUnits: 99n, vaultReservedUnits: 1n };
  const result = await new ConservationReconciler("test:10143:event", source, store).runAtCursor();
  expect(result?.differences).toEqual(["LEDGER_LIABILITY", "VAULT_RESERVED"]);
  expect(store.reconciliations).toHaveLength(1);
  expect(store.snapshot).toEqual({ ledgerLiabilityUnits: 100n, vaultReservedUnits: 0n });
});
