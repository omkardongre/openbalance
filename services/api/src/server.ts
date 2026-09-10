import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadEnvironment } from "./config.js";
import { DeploymentChain } from "./deployment-chain.js";
import { DeploymentService } from "./deployments.js";
import { EnrollmentService } from "./enrollment.js";

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
const app = await buildApp(service, environment.WEBAUTHN_ORIGIN, deployment);
if (pool) app.addHook("onClose", async () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });

await app.listen({ host: environment.HOST, port: environment.PORT });
