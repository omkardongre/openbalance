import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { AccountAccessService } from "./account-access.js";
import { buildApp } from "./app.js";
import { CheckoutService } from "./checkout.js";
import { ViemCheckoutPolicyVerifier } from "./checkout-chain.js";
import { loadCheckoutManifest } from "./checkout-manifest.js";
import { loadEnvironment } from "./config.js";
import { DeploymentChain } from "./deployment-chain.js";
import { DeploymentService } from "./deployments.js";
import { EnrollmentService } from "./enrollment.js";
import { IncidentService } from "./incidents.js";
import { OperationalReadService } from "./operations.js";
import { OperationsAccessService } from "./operations-access.js";
import { OperationsReportingService } from "./operations-reporting.js";

const environment = loadEnvironment(process.env);
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
    const checkout = new CheckoutService(
      pool,
      checkoutManifest,
      new ViemCheckoutPolicyVerifier(environment.ACCOUNT_RPC_URL as string),
      capabilityKey,
    );
    await checkout.assertReady();
    control.checkout = checkout;
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
  );
  await chain.checkpoint();
  await pool.query("SELECT enrollment_id FROM account_deployments LIMIT 0");
  deployment = new DeploymentService(pool, chain, {
    rpId: environment.WEBAUTHN_RP_ID,
    origin: environment.WEBAUTHN_ORIGIN,
  });
}
const app = await buildApp(
  service,
  environment.WEBAUTHN_ORIGIN,
  deployment,
  access,
  operations,
  control,
);
if (pool) app.addHook("onClose", async () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });

await app.listen({ host: environment.HOST, port: environment.PORT });
