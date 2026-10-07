import { setTimeout as delay } from "node:timers/promises";
import { startTelemetry, writeLog } from "@openbalance/observability";
import { Pool } from "pg";
import { defineChain } from "viem";
import { loadIndexerConfig } from "./config.js";
import { HyperSyncFinalizedChainSource, HyperSyncLogClient } from "./hypersync.js";
import { FinalizedHistoryConflict, FinalizedIndexer } from "./indexer.js";
import { ProvisionalIndexer, ProvisionalReorgTooDeep } from "./provisional.js";
import { ConservationReconciler } from "./reconciliation.js";
import { DeploymentManifestMismatch, ViemFinalizedChainSource } from "./source.js";
import { PgIndexerStore } from "./store.js";

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}) {
  writeLog("openbalance-indexer", level, message, fields);
}

async function main() {
  const config = loadIndexerConfig(process.env);
  const telemetry = await startTelemetry({
    serviceName: "openbalance-indexer",
    metricsPort: Number(process.env.METRICS_PORT ?? "9467"),
    ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? { otlpTraceUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
      : {}),
  });
  const finalizedTransitions = telemetry.meter.createCounter("openbalance_finalized_transitions", {
    unit: "{transition}",
  });
  const reconciliationDifferences = telemetry.meter.createCounter(
    "openbalance_reconciliation_differences",
    { unit: "{difference}" },
  );
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
  const rpcSource = new ViemFinalizedChainSource({
    rpcUrl: config.rpcUrl,
    chain,
    contracts: config.contracts,
    finalityTag: config.finalityTag,
    maxLogRange: config.rpcLogRange,
  });
  const logBatches = telemetry.meter.createCounter("openbalance_indexer_log_batches", {
    unit: "{batch}",
  });
  // HyperSync supplies finalized logs; heads, block hashes and conservation reads stay on the RPC.
  const source = config.hypersync
    ? new HyperSyncFinalizedChainSource({
        rpc: rpcSource,
        hypersync: new HyperSyncLogClient({
          url: config.hypersync.url,
          apiToken: config.hypersync.apiToken,
          contracts: config.contracts,
        }),
        catchUpMilliseconds: config.hypersync.catchUpMilliseconds,
        onSuccess: () => logBatches.add(1, { source: "hypersync" }),
        onFallback: (error, fromBlock, toBlock) => {
          logBatches.add(1, { source: "rpc_fallback", reason: error.reason });
          log(
            error.reason === "AUTH" ? "error" : "info",
            "HyperSync unavailable; batch read from RPC",
            {
              reason: error.reason,
              detail: error.message,
              fromBlock: fromBlock.toString(),
              toBlock: toBlock.toString(),
            },
          );
        },
      })
    : rpcSource;
  log("info", "Indexer log source", { logSource: config.hypersync ? "envio-hypersync" : "rpc" });
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
  const provisional = config.provisionalEnabled
    ? new ProvisionalIndexer({
        streamId: config.streamId,
        chainId: BigInt(config.chainId),
        eventId: config.eventId,
        contracts: config.contracts,
        deploymentBlock: config.deploymentBlock,
        // The provisional tail is read over RPC, so it keeps an RPC-sized batch.
        batchSize: config.rpcLogRange,
        maximumReorgDepth: config.provisionalReorgDepth,
        // The provisional tail is above the finalized head, where HyperSync has not ingested yet.
        source: rpcSource,
        store,
      })
    : undefined;
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
      // Backfill runs batch after batch; the poll interval applies once caught up or after an error.
      let behind = false;
      try {
        const run = await indexer.runOnce();
        behind = !run.caughtUp;
        if (run.toBlock !== null)
          log("info", "Finalized batch committed", {
            fromBlock: run.fromBlock?.toString(),
            toBlock: run.toBlock.toString(),
            transitionCount: run.transitionCount,
          });
        finalizedTransitions.add(run.transitionCount);
        if (run.caughtUp) {
          const reconciliation = await reconciler.runAtCursor();
          if (reconciliation) reconciliationDifferences.add(reconciliation.differences.length);
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
        if (provisional) {
          const observed = await provisional.runOnce();
          if (observed.toBlock !== null)
            log("info", "Provisional batch observed", {
              fromBlock: observed.fromBlock?.toString(),
              toBlock: observed.toBlock.toString(),
              transitionCount: observed.transitionCount,
              rewound: observed.rewound,
            });
        }
      } catch (error) {
        log("error", error instanceof Error ? error.message : "Indexer iteration failed");
        if (
          error instanceof FinalizedHistoryConflict ||
          error instanceof DeploymentManifestMismatch ||
          error instanceof ProvisionalReorgTooDeep
        ) {
          process.exitCode = 1;
          break;
        }
      }
      if (!stopping && !behind) await delay(config.pollIntervalMilliseconds);
    }
  } finally {
    await pool.end();
    await telemetry.shutdown();
    log("info", "Indexer stopped");
  }
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? error.message : "Indexer startup failed");
  process.exitCode = 1;
});
