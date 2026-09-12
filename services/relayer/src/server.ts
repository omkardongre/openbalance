import { readFile } from "node:fs/promises";
import { AccountAccessService } from "@openbalance/api/account-access";
import { DeploymentChain } from "@openbalance/api/deployment-chain";
import { DeploymentService } from "@openbalance/api/deployments";
import { DeploymentSponsorshipService, loadSponsorAccount } from "@openbalance/api/sponsorship";
import { Pool } from "pg";
import { buildRelayerApp } from "./app.js";
import { AttendeeFinancialCommandService } from "./attendee-commands.js";
import { AttendeeReclaimService } from "./attendee-reclaims.js";
import { loadRelayerEnvironment } from "./config.js";
import { loadFinancialEventManifest } from "./financial-manifest.js";
import { ViemFinancialManifestVerifier } from "./financial-manifest-chain.js";
import { FinancialOperationJournal } from "./financial-operations.js";
import { VendorFinancialCommandService } from "./vendor-commands.js";
import { VendorTreasuryAccessService } from "./vendor-treasury-access.js";

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
let financial:
  | {
      access: AccountAccessService;
      commands: AttendeeFinancialCommandService;
      reclaims: AttendeeReclaimService;
      treasuryAccess: VendorTreasuryAccessService;
      treasuryCommands: VendorFinancialCommandService;
    }
  | undefined;
if (environment.FINANCIAL_EVENT_MANIFEST_PATH) {
  const manifest = await loadFinancialEventManifest(environment.FINANCIAL_EVENT_MANIFEST_PATH);
  await new ViemFinancialManifestVerifier(environment.ACCOUNT_RPC_URL).assert(manifest);
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
    reclaims: new AttendeeReclaimService({ pool, journal, manifest }),
    treasuryAccess,
    treasuryCommands: new VendorFinancialCommandService({
      journal,
      manifest,
      maximumLifetimeSeconds: BigInt(environment.FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS),
    }),
  };
}
const app = await buildRelayerApp(sponsorship, environment.WEBAUTHN_ORIGIN, financial);
app.addHook("onClose", async () => pool.end());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: environment.HOST, port: environment.PORT });
