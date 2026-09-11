import { readFile } from "node:fs/promises";
import { DeploymentChain } from "@openbalance/api/deployment-chain";
import { DeploymentService } from "@openbalance/api/deployments";
import { DeploymentSponsorshipService, loadSponsorAccount } from "@openbalance/api/sponsorship";
import { Pool } from "pg";
import { buildRelayerApp } from "./app.js";
import { loadRelayerEnvironment } from "./config.js";

const environment = loadRelayerEnvironment(process.env);
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
const app = await buildRelayerApp(sponsorship, environment.WEBAUTHN_ORIGIN);
app.addHook("onClose", async () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: environment.HOST, port: environment.PORT });
