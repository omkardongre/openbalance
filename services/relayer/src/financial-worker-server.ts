import { setTimeout as delay } from "node:timers/promises";
import { loadSponsorAccount } from "@openbalance/api/sponsorship";
import { startTelemetry, writeLog } from "@openbalance/observability";
import { Pool } from "pg";
import { defineChain } from "viem";
import { loadFinancialWorkerEnvironment } from "./config.js";
import { DatabaseFinancialCommandPolicy } from "./database-financial-policy.js";
import { loadFinancialEventManifest } from "./financial-manifest.js";
import { ViemFinancialManifestVerifier } from "./financial-manifest-chain.js";
import { FinancialOperationJournal } from "./financial-operations.js";
import { FinancialOperationWorker } from "./financial-worker.js";
import { ViemFinancialFinalityVerifier } from "./viem-financial-finality.js";
import { ViemFinancialTransactionGateway } from "./viem-financial-gateway.js";

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}) {
  writeLog("openbalance-financial-worker", level, message, fields);
}

async function main() {
  const config = loadFinancialWorkerEnvironment(process.env);
  const telemetry = await startTelemetry({
    serviceName: "openbalance-financial-worker",
    metricsPort: Number(process.env.METRICS_PORT ?? "9469"),
    ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? { otlpTraceUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
      : {}),
  });
  const outcomes = telemetry.meter.createCounter("openbalance_financial_operation_outcomes", {
    unit: "{operation}",
  });
  const manifest = await loadFinancialEventManifest(config.FINANCIAL_EVENT_MANIFEST_PATH);
  await new ViemFinancialManifestVerifier(
    config.FINANCIAL_RPC_URL,
    config.FINANCIAL_FINALITY_TAG,
  ).assert(manifest);
  const chain = defineChain({
    id: manifest.chainId,
    name: config.FINANCIAL_CHAIN_NAME,
    nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [config.FINANCIAL_RPC_URL] } },
  });
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: "openbalance-financial-worker",
  });
  const journal = new FinancialOperationJournal(pool);
  await journal.assertReady();
  // Sponsored throughput is capped per key by the chain's inflight gas budget, so concurrency comes
  // from more keys rather than a larger allowance. Each path is loaded under the same permission
  // checks, and duplicates are rejected so a repeated path cannot look like added capacity.
  const keyPaths = [
    config.FINANCIAL_SIGNER_PRIVATE_KEY_PATH,
    ...(config.FINANCIAL_SIGNER_ADDITIONAL_KEY_PATHS?.split(",") ?? []),
  ]
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  if (new Set(keyPaths).size !== keyPaths.length)
    throw new Error("Duplicate financial signing key path configured");
  const accounts = await Promise.all(keyPaths.map((path) => loadSponsorAccount(path)));
  const worker = new FinancialOperationWorker({
    journal,
    gateway: new ViemFinancialTransactionGateway({
      rpcUrl: config.FINANCIAL_RPC_URL,
      chain,
      accounts,
      gasLimitMarginBps: config.FINANCIAL_GAS_LIMIT_MARGIN_BPS,
      reserveBalanceWei: BigInt(config.FINANCIAL_RESERVE_BALANCE_WEI),
      finalityTag: config.FINANCIAL_FINALITY_TAG,
    }),
    policy: new DatabaseFinancialCommandPolicy({
      pool,
      manifest,
      maxGasLimit: BigInt(config.FINANCIAL_MAX_GAS),
      maxFeePerGas: BigInt(config.FINANCIAL_MAX_FEE_PER_GAS_WEI),
      maxCost: BigInt(config.FINANCIAL_MAX_COST_WEI),
    }),
    finality: new ViemFinancialFinalityVerifier({
      rpcUrl: config.FINANCIAL_RPC_URL,
      chain,
      finalityTag: config.FINANCIAL_FINALITY_TAG,
    }),
    owner: config.FINANCIAL_WORKER_ID,
    batchSize: config.FINANCIAL_BATCH_SIZE,
    leaseMilliseconds: config.FINANCIAL_LEASE_MS,
    retryDelayMilliseconds: config.FINANCIAL_RETRY_MS,
  });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    log("info", "Financial worker started", { chainId: manifest.chainId });
    while (!stopping) {
      try {
        const run = await worker.runOnce();
        for (const [state, count] of Object.entries(run)) outcomes.add(count, { state });
        if (Object.values(run).some((count) => count > 0)) log("info", "Financial worker run", run);
      } catch (error) {
        log("error", error instanceof Error ? error.message : "Financial worker run failed");
      }
      if (!stopping) await delay(config.FINANCIAL_POLL_MS);
    }
  } finally {
    await pool.end();
    await telemetry.shutdown();
    log("info", "Financial worker stopped");
  }
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? error.message : "Financial worker startup failed");
  process.exitCode = 1;
});
