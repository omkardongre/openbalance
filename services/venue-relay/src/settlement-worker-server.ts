import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startTelemetry, writeLog } from "@openbalance/observability";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ViemVoucherSettlementGateway } from "./chain.js";
import { loadVenueRelaySettlementEnvironment } from "./config.js";
import { VenueRelayJournal } from "./journal.js";
import { loadRelayKey } from "./key.js";
import { VoucherSettlementProcessor } from "./settlement.js";

function log(level: "info" | "error", message: string, fields: Record<string, unknown> = {}) {
  writeLog("openbalance-venue-relay-settlement", level, message, fields);
}

async function loadSettlementAccount(path: string) {
  const text = (await readFile(path, "utf8")).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error("Settlement private key file must contain a 32-byte hex key");
  return privateKeyToAccount(text as `0x${string}`);
}

async function main() {
  const config = loadVenueRelaySettlementEnvironment(process.env);
  const telemetry = await startTelemetry({
    serviceName: "openbalance-venue-relay-settlement",
    metricsPort: Number(process.env.METRICS_PORT ?? "9467"),
    ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
      ? { otlpTraceUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
      : {}),
  });
  const outcomes = telemetry.meter.createCounter("openbalance_voucher_settlement_outcomes", {
    unit: "{receipt}",
  });
  const key = await loadRelayKey(config.VENUE_RELAY_KEY_PATH);
  const journal = new VenueRelayJournal(config.VENUE_RELAY_DATABASE_PATH, key);
  key.fill(0);
  journal.assertReady();
  const account = await loadSettlementAccount(config.VENUE_RELAY_SETTLEMENT_PRIVATE_KEY_PATH);
  const chain = defineChain({
    id: config.VENUE_RELAY_CHAIN_ID,
    name: config.VENUE_RELAY_CHAIN_NAME,
    nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [config.VENUE_RELAY_RPC_URL] } },
  });
  const processor = new VoucherSettlementProcessor(
    journal,
    new ViemVoucherSettlementGateway({
      rpcUrl: config.VENUE_RELAY_RPC_URL,
      chain,
      account,
      vault: config.VENUE_RELAY_VAULT_ADDRESS,
      deploymentBlock: config.VENUE_RELAY_DEPLOYMENT_BLOCK,
      finalityTag: config.VENUE_RELAY_FINALITY_TAG,
    }),
    {
      owner: config.VENUE_RELAY_SETTLEMENT_WORKER_ID,
      leaseMilliseconds: config.VENUE_RELAY_SETTLEMENT_LEASE_MS,
      pollMilliseconds: config.VENUE_RELAY_SETTLEMENT_POLL_MS,
    },
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    log("info", "Voucher settlement worker started", { chainId: config.VENUE_RELAY_CHAIN_ID });
    while (!stopping) {
      try {
        const batch = await processor.runBatch(config.VENUE_RELAY_SETTLEMENT_BATCH_SIZE);
        for (const outcome of batch) outcomes.add(1, { state: outcome.state });
        if (batch.length > 0)
          log("info", "Voucher settlement run", {
            receipts: batch.length,
            states: batch.map((outcome) => outcome.state),
            errors: batch.map((outcome) => outcome.transactionHash ?? "-"),
          });
      } catch (error) {
        log("error", error instanceof Error ? error.message : "Voucher settlement run failed");
      }
      if (!stopping) await delay(config.VENUE_RELAY_SETTLEMENT_POLL_MS);
    }
  } finally {
    journal.close();
    await telemetry.shutdown();
    log("info", "Voucher settlement worker stopped");
  }
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? error.message : "Voucher settlement startup failed");
  process.exitCode = 1;
});
