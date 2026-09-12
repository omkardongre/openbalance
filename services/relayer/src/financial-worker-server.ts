import { setTimeout as delay } from "node:timers/promises";
import { loadSponsorAccount } from "@openbalance/api/sponsorship";
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
  const line = JSON.stringify({ level, service: "financial-worker", message, ...fields });
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

async function main() {
  const config = loadFinancialWorkerEnvironment(process.env);
  const manifest = await loadFinancialEventManifest(config.FINANCIAL_EVENT_MANIFEST_PATH);
  await new ViemFinancialManifestVerifier(config.FINANCIAL_RPC_URL).assert(manifest);
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
  const account = await loadSponsorAccount(config.FINANCIAL_SIGNER_PRIVATE_KEY_PATH);
  const worker = new FinancialOperationWorker({
    journal,
    gateway: new ViemFinancialTransactionGateway({
      rpcUrl: config.FINANCIAL_RPC_URL,
      chain,
      account,
    }),
    policy: new DatabaseFinancialCommandPolicy({
      pool,
      manifest,
      maxGasLimit: BigInt(config.FINANCIAL_MAX_GAS),
      maxFeePerGas: BigInt(config.FINANCIAL_MAX_FEE_PER_GAS_WEI),
      maxCost: BigInt(config.FINANCIAL_MAX_COST_WEI),
    }),
    finality: new ViemFinancialFinalityVerifier({ rpcUrl: config.FINANCIAL_RPC_URL, chain }),
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
        if (Object.values(run).some((count) => count > 0)) log("info", "Financial worker run", run);
      } catch (error) {
        log("error", error instanceof Error ? error.message : "Financial worker run failed");
      }
      if (!stopping) await delay(config.FINANCIAL_POLL_MS);
    }
  } finally {
    await pool.end();
    log("info", "Financial worker stopped");
  }
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? error.message : "Financial worker startup failed");
  process.exitCode = 1;
});
