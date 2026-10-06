import { readFile } from "node:fs/promises";
import { AccountAccessService } from "@openbalance/api/account-access";
import { DeploymentChain } from "@openbalance/api/deployment-chain";
import { DeploymentService } from "@openbalance/api/deployments";
import { DeploymentSponsorshipService, loadSponsorAccount } from "@openbalance/api/sponsorship";
import { startTelemetry } from "@openbalance/observability";
import { Pool } from "pg";
import { createPublicClient, http } from "viem";
import { buildRelayerApp } from "./app.js";
import { AttendeeFinancialCommandService } from "./attendee-commands.js";
import { loadRelayerEnvironment } from "./config.js";
import { loadFinancialEventManifest } from "./financial-manifest.js";
import { ViemFinancialManifestVerifier } from "./financial-manifest-chain.js";
import { FinancialOperationJournal } from "./financial-operations.js";
import { ReserveReclaimService } from "./reserve-reclaims.js";
import { VendorFinancialCommandService } from "./vendor-commands.js";
import { VendorTreasuryAccessService } from "./vendor-treasury-access.js";
import { finalizedChannelReader, VendorVoucherSettlementService } from "./vendor-vouchers.js";

const environment = loadRelayerEnvironment(process.env);
const telemetry = await startTelemetry({
  serviceName: "openbalance-relayer",
  metricsPort: Number(process.env.METRICS_PORT ?? "9465"),
  ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ? { otlpTraceUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
    : {}),
});
const pool = new Pool({
  connectionString: environment.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});
const policy = { rpId: environment.WEBAUTHN_RP_ID, origin: environment.WEBAUTHN_ORIGIN };
const chain = new DeploymentChain(
  JSON.parse(await readFile(environment.ACCOUNT_MANIFEST_PATH, "utf8")),
  environment.ACCOUNT_RPC_URL,
  environment.ACCOUNT_FINALITY_TAG,
);
await chain.checkpoint();
await pool.query("SELECT id FROM deployment_sponsorships LIMIT 0");
const sponsorship = new DeploymentSponsorshipService(
  pool,
  new DeploymentService(pool, chain, policy),
  await loadSponsorAccount(environment.SPONSOR_PRIVATE_KEY_PATH),
  {
    dailyDeployments: environment.SPONSOR_DAILY_DEPLOYMENTS,
    maxGas: BigInt(environment.SPONSOR_MAX_DEPLOYMENT_GAS),
    maxFeePerGas: BigInt(environment.SPONSOR_MAX_FEE_PER_GAS_WEI),
    maxCost: BigInt(environment.SPONSOR_MAX_COST_WEI),
  },
);
await sponsorship.reconcilePending();
let financial:
  | {
      access: AccountAccessService;
      commands: AttendeeFinancialCommandService;
      reclaims: ReserveReclaimService;
      treasuryAccess: VendorTreasuryAccessService;
      treasuryCommands: VendorFinancialCommandService;
      voucherSettlements: VendorVoucherSettlementService;
    }
  | undefined;
/**
 * Chain-domain clock for gates the contracts evaluate against `block.timestamp`. Reserve reclaim
 * eligibility and intent sponsorship windows are contract rules, so they must not be decided by this
 * process's wall clock, which can drift from the chain.
 */
const settlementChainClient = createPublicClient({
  transport: http(environment.ACCOUNT_RPC_URL, { retryCount: 2, timeout: 10_000 }),
});
const settlementChainSeconds = async () =>
  (await settlementChainClient.getBlock({ blockTag: environment.ACCOUNT_FINALITY_TAG })).timestamp;

if (environment.FINANCIAL_EVENT_MANIFEST_PATH) {
  const manifest = await loadFinancialEventManifest(environment.FINANCIAL_EVENT_MANIFEST_PATH);
  await new ViemFinancialManifestVerifier(
    environment.ACCOUNT_RPC_URL,
    environment.ACCOUNT_FINALITY_TAG,
  ).assert(manifest);
  const journal = new FinancialOperationJournal(pool);
  await journal.assertReady();
  const treasuryAccess = new VendorTreasuryAccessService(pool);
  await treasuryAccess.assertReady();
  financial = {
    access: new AccountAccessService(pool, policy),
    commands: new AttendeeFinancialCommandService({
      journal,
      chainId: BigInt(manifest.chainId),
      events: manifest.events,
      maximumLifetimeSeconds: BigInt(environment.FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS),
    }),
    reclaims: new ReserveReclaimService({
      pool,
      journal,
      manifest,
      chainSeconds: settlementChainSeconds,
    }),
    treasuryAccess,
    treasuryCommands: new VendorFinancialCommandService({
      journal,
      manifest,
      maximumLifetimeSeconds: BigInt(environment.FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS),
      chainSeconds: settlementChainSeconds,
    }),
    voucherSettlements: new VendorVoucherSettlementService({
      journal,
      manifest,
      channel: finalizedChannelReader(pool),
      maximumLifetimeSeconds: BigInt(environment.FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS),
      chainSeconds: settlementChainSeconds,
    }),
  };
}
const app = await buildRelayerApp(sponsorship, environment.WEBAUTHN_ORIGIN, financial, [
  {
    name: "database",
    check: async () => {
      await pool.query("SELECT 1");
    },
  },
  {
    name: "account-chain",
    check: async () => {
      await chain.checkpoint();
    },
  },
]);
app.addHook("onClose", async () => {
  await pool.end();
  await telemetry.shutdown();
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: environment.HOST, port: environment.PORT });
