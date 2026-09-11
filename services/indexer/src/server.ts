import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { defineChain } from "viem";
import { loadIndexerConfig } from "./config.js";
import { FinalizedHistoryConflict, FinalizedIndexer } from "./indexer.js";
import { ConservationReconciler } from "./reconciliation.js";
import { DeploymentManifestMismatch, ViemFinalizedChainSource } from "./source.js";
import { PgIndexerStore } from "./store.js";

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}) {
  const value = JSON.stringify({
    level,
    service: "indexer",
    message,
    ...fields,
  });
  (level === "error" ? process.stderr : process.stdout).write(`${value}\n`);
}

async function main() {
  const config = loadIndexerConfig(process.env);
  const chain = defineChain({
    id: config.chainId,
    name: config.chainName,
    nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    application_name: "openbalance-indexer",
  });
  const store = new PgIndexerStore(pool);
  const source = new ViemFinalizedChainSource({
    rpcUrl: config.rpcUrl,
    chain,
    contracts: config.contracts,
  });
  const indexer = new FinalizedIndexer({
    streamId: config.streamId,
    chainId: BigInt(config.chainId),
    eventId: config.eventId,
    contracts: config.contracts,
    deploymentBlock: config.deploymentBlock,
    batchSize: config.batchSize,
    source,
    store,
  });
  const reconciler = new ConservationReconciler(config.streamId, source, store);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await store.assertReady();
    log("info", "Indexer started", { streamId: config.streamId });
    while (!stopping) {
      try {
        const run = await indexer.runOnce();
        if (run.toBlock !== null)
          log("info", "Finalized batch committed", {
            fromBlock: run.fromBlock?.toString(),
            toBlock: run.toBlock.toString(),
            transitionCount: run.transitionCount,
          });
        if (run.caughtUp) {
          const reconciliation = await reconciler.runAtCursor();
          if (reconciliation)
            log(
              reconciliation.differences.length === 0 ? "info" : "error",
              "Finalized conservation reconciled",
              {
                blockNumber: reconciliation.blockNumber.toString(),
                differences: reconciliation.differences,
              },
            );
        }
      } catch (error) {
        log("error", error instanceof Error ? error.message : "Indexer iteration failed");
        if (
          error instanceof FinalizedHistoryConflict ||
          error instanceof DeploymentManifestMismatch
        ) {
          process.exitCode = 1;
          break;
        }
      }
      if (!stopping) await delay(config.pollIntervalMilliseconds);
    }
  } finally {
    await pool.end();
    log("info", "Indexer stopped");
  }
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? error.message : "Indexer startup failed");
  process.exitCode = 1;
});
