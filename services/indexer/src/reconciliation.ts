import { createHash } from "node:crypto";
import { FinalizedHistoryConflict } from "./indexer.js";
import type { FinalizedChainSource } from "./source.js";
import type { IndexerStore } from "./store.js";
import type { ReconciliationResult } from "./types.js";

export class ConservationReconciler {
  constructor(
    private readonly streamId: string,
    private readonly source: FinalizedChainSource,
    private readonly store: IndexerStore,
  ) {}

  async runAtCursor(): Promise<ReconciliationResult | null> {
    const projected = await this.store.getExpectedConservation(this.streamId);
    if (!projected) return null;
    const canonical = await this.source.getBlock(projected.cursor.blockNumber);
    if (canonical.hash.toLowerCase() !== projected.cursor.blockHash.toLowerCase()) {
      const message = `Finalized reconciliation block disagrees at ${projected.cursor.blockNumber}`;
      await this.store.recordIntegrityIncident({
        streamId: this.streamId,
        code: "FINALIZED_HISTORY_CONTRADICTION",
        blockNumber: projected.cursor.blockNumber,
        expectedBlockHash: projected.cursor.blockHash,
        observedBlockHash: canonical.hash,
        message,
      });
      throw new FinalizedHistoryConflict(message);
    }
    const actual = await this.source.readConservation(projected.cursor.blockNumber);
    const differences: ReconciliationResult["differences"] = [
      ...(actual.ledgerLiabilityUnits === projected.snapshot.ledgerLiabilityUnits
        ? []
        : (["LEDGER_LIABILITY"] as const)),
      ...(actual.vaultReservedUnits === projected.snapshot.vaultReservedUnits
        ? []
        : (["VAULT_RESERVED"] as const)),
    ];
    const result: ReconciliationResult = {
      runId: createHash("sha256")
        .update(`${this.streamId}:${projected.cursor.blockHash.toLowerCase()}`)
        .digest("hex"),
      blockNumber: projected.cursor.blockNumber,
      blockHash: projected.cursor.blockHash,
      expected: projected.snapshot,
      actual,
      differences,
    };
    await this.store.recordReconciliation(result, this.streamId);
    return result;
  }
}
