import { readFile } from "node:fs/promises";
import { startTelemetry } from "@openbalance/observability";
import { Pool } from "pg";
import { type Address, defineChain } from "viem";
import { AccountAccessService } from "./account-access.js";
import { buildApp } from "./app.js";
import { CheckoutService } from "./checkout.js";
import { ViemCheckoutPolicyVerifier } from "./checkout-chain.js";
import { loadCheckoutManifest } from "./checkout-manifest.js";
import { loadEnvironment } from "./config.js";
import { DeploymentChain } from "./deployment-chain.js";
import { DeploymentService } from "./deployments.js";
import { EnrollmentService } from "./enrollment.js";
import {
  FaucetService,
  loadFaucetAccount,
  PostgresFaucetLedger,
  ViemFaucetChain,
} from "./faucet.js";
import { IncidentService } from "./incidents.js";
import { OperationalReadService } from "./operations.js";
import { OperationsAccessService } from "./operations-access.js";
import { OperationsReportingService } from "./operations-reporting.js";
import { OrganizerConfigurationService } from "./organizer-configuration.js";
import { ViemOrganizerConfigurationChain } from "./organizer-configuration-chain.js";
import { StallOnboardingService } from "./stall-onboarding.js";
import { ViemStallChain } from "./stall-onboarding-chain.js";
import { loadTimeAuthority } from "./time-authority.js";

const environment = loadEnvironment(process.env);
const telemetry = await startTelemetry({
  serviceName: "openbalance-api",
  metricsPort: Number(process.env.METRICS_PORT ?? "9464"),
  ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ? { otlpTraceUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
    : {}),
});
const pool = environment.DATABASE_URL
  ? new Pool({
      connectionString: environment.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    })
  : undefined;
const service =
  pool && environment.WEBAUTHN_RP_ID && environment.WEBAUTHN_ORIGIN
    ? new EnrollmentService(pool, {
        rpId: environment.WEBAUTHN_RP_ID,
        origin: environment.WEBAUTHN_ORIGIN,
      })
    : undefined;
if (pool) await pool.query("SELECT id FROM account_enrollments LIMIT 0");
let deployment: DeploymentService | undefined;
let access: AccountAccessService | undefined;
let operations: OperationalReadService | undefined;
let control: Parameters<typeof buildApp>[5];
if (pool && environment.WEBAUTHN_RP_ID && environment.WEBAUTHN_ORIGIN) {
  access = new AccountAccessService(pool, {
    rpId: environment.WEBAUTHN_RP_ID,
    origin: environment.WEBAUTHN_ORIGIN,
  });
  await pool.query("SELECT id FROM account_sessions LIMIT 0");
}
if (pool && environment.PROJECTION_READS_ENABLED) {
  operations = new OperationalReadService(pool);
  await operations.assertReady();
  const operationsAccess = new OperationsAccessService(pool);
  const reporting = new OperationsReportingService(pool);
  const incidents = new IncidentService(pool);
  await Promise.all([
    operationsAccess.assertReady(),
    reporting.assertReady(),
    incidents.assertReady(),
  ]);
  control = { access: operationsAccess, reporting, incidents };
  if (environment.CHECKOUT_MANIFEST_PATH && environment.CHECKOUT_CAPABILITY_KEY_PATH) {
    const [checkoutManifest, capabilityKey] = await Promise.all([
      loadCheckoutManifest(environment.CHECKOUT_MANIFEST_PATH),
      readFile(environment.CHECKOUT_CAPABILITY_KEY_PATH),
    ]);
    if (capabilityKey.length < 32 || capabilityKey.length > 64)
      throw new Error("Checkout capability key must contain 32 to 64 raw bytes");
    const stalls = new StallOnboardingService(
      pool,
      checkoutManifest,
      new ViemStallChain(environment.ACCOUNT_RPC_URL as string),
    );
    const checkout = new CheckoutService(
      pool,
      checkoutManifest,
      new ViemCheckoutPolicyVerifier(environment.ACCOUNT_RPC_URL as string),
      capabilityKey,
      undefined,
      stalls,
      environment.CHECKOUT_UNLISTED_VENDOR_IDS,
    );
    const organizerConfiguration = new OrganizerConfigurationService(
      pool,
      checkoutManifest,
      new ViemOrganizerConfigurationChain(environment.ACCOUNT_RPC_URL as string),
    );
    await Promise.all([
      checkout.assertReady(),
      organizerConfiguration.assertReady(),
      stalls.assertReady(),
    ]);
    control.checkout = checkout;
    control.stalls = stalls;
    control.organizerConfiguration = organizerConfiguration;
  }
}
if (
  pool &&
  environment.ACCOUNT_MANIFEST_PATH &&
  environment.ACCOUNT_RPC_URL &&
  environment.WEBAUTHN_RP_ID &&
  environment.WEBAUTHN_ORIGIN
) {
  const chain = new DeploymentChain(
    JSON.parse(await readFile(environment.ACCOUNT_MANIFEST_PATH, "utf8")),
    environment.ACCOUNT_RPC_URL,
    environment.ACCOUNT_FINALITY_TAG,
  );
  await chain.checkpoint();
  await pool.query("SELECT enrollment_id FROM account_deployments LIMIT 0");
  deployment = new DeploymentService(pool, chain, {
    rpId: environment.WEBAUTHN_RP_ID,
    origin: environment.WEBAUTHN_ORIGIN,
  });
}
let faucet: FaucetService | undefined;
if (
  pool &&
  environment.FAUCET_RPC_URL &&
  environment.FAUCET_CHAIN_ID &&
  environment.FAUCET_CHAIN_NAME &&
  environment.FAUCET_TOKEN_ADDRESS &&
  environment.FAUCET_PRIVATE_KEY_PATH &&
  environment.FAUCET_MAX_AMOUNT &&
  environment.FAUCET_DAILY_LIMIT &&
  environment.FAUCET_ACCOUNT_LIMIT
) {
  const ledger = new PostgresFaucetLedger(pool);
  await ledger.assertReady();
  const account = await loadFaucetAccount(environment.FAUCET_PRIVATE_KEY_PATH);
  const token = environment.FAUCET_TOKEN_ADDRESS as Address;
  const chain = defineChain({
    id: environment.FAUCET_CHAIN_ID,
    name: environment.FAUCET_CHAIN_NAME,
    nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [environment.FAUCET_RPC_URL] } },
  });
  faucet = new FaucetService(
    ledger,
    new ViemFaucetChain({ rpcUrl: environment.FAUCET_RPC_URL, chain, account, token }),
    {
      chainId: environment.FAUCET_CHAIN_ID,
      token,
      maxAmount: BigInt(environment.FAUCET_MAX_AMOUNT),
      dailyLimit: BigInt(environment.FAUCET_DAILY_LIMIT),
      accountLimit: BigInt(environment.FAUCET_ACCOUNT_LIMIT),
    },
  );
}
const timeAuthority = environment.TIME_AUTHORITY_KEY_PATH
  ? await loadTimeAuthority(environment.TIME_AUTHORITY_KEY_PATH)
  : undefined;
const app = await buildApp(
  service,
  environment.WEBAUTHN_ORIGIN,
  deployment,
  access,
  operations,
  control,
  faucet,
  timeAuthority,
  pool
    ? [
        {
          name: "database",
          check: async () => {
            await pool.query("SELECT 1");
          },
        },
      ]
    : [],
);
app.addHook("onClose", async () => {
  if (pool) await pool.end();
  await telemetry.shutdown();
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });

await app.listen({ host: environment.HOST, port: environment.PORT });
