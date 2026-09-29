// Drives one step of the journey against the deployed testnet services.
//
//   node scripts/run-deployed-journey.mjs <api-enroll|api-fund|checkout|treasury> <state-file>
//
// Every input comes from committed manifests or the gitignored `secrets/testnet/` tree and is passed
// to the scenario process through its environment only, so no key or token reaches the process table,
// the shell history or this script's output. The RPC URL embeds a provider key and is redacted from
// anything the child prints before it is forwarded.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const secrets = join(root, "secrets", "testnet");
const deployments = join(root, "deployments", "testnet");

const [kind, statePath] = process.argv.slice(2);
const kinds = ["api-enroll", "api-fund", "checkout", "treasury"];
if (!kinds.includes(kind) || !statePath) {
  process.stderr.write(`Usage: run-deployed-journey.mjs <${kinds.join("|")}> <state-file>\n`);
  process.exit(64);
}

process.loadEnvFile(process.env.OPENBALANCE_ENV_FILE ?? join(root, ".env.testnet"));
const rpcUrl = process.env.ACCOUNT_RPC_URL;
if (!rpcUrl?.startsWith("https://")) throw new Error("ACCOUNT_RPC_URL must be an https URL");

const secret = (name) => readFileSync(join(secrets, name), "utf8").trim();
const provisioning = JSON.parse(readFileSync(join(deployments, "event-provisioning.json"), "utf8"));
const financial = JSON.parse(
  readFileSync(join(deployments, "financial-manifest.json"), "utf8"),
).events.find((event) => event.eventId === provisioning.eventId);
if (!financial) throw new Error("financial-manifest.json does not contain the provisioned event");

const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER ?? "607263679674";
const region = process.env.GOOGLE_CLOUD_REGION ?? "us-central1";
const service = (name) => `https://openbalance-testnet-${name}-${projectNumber}.${region}.run.app`;
// The passkey origin the API and relayer trust (Terraform `web_public_url`), not the web service's
// run.app host, which only the load balancer may reach once the origin has moved.
const origin = process.env.SCENARIO_ORIGIN ?? "https://openbalance.countersign.site";

const environment = {
  ...process.env,
  SCENARIO_KIND: kind,
  SCENARIO_RPC_URL: rpcUrl,
  SCENARIO_DEPLOYER_PRIVATE_KEY: secret("harness-signer"),
  SCENARIO_API_URL: service("api"),
  SCENARIO_RELAYER_URL: service("relayer"),
  SCENARIO_STATE_PATH: statePath,
  SCENARIO_ORIGIN: origin,
  SCENARIO_RP_ID: new URL(origin).hostname,
};

// A persistent database has seen every credential ever enrolled, so each enrollment needs a fresh one.
if (kind === "api-enroll" && !process.env.SCENARIO_CREDENTIAL_ID)
  environment.SCENARIO_CREDENTIAL_ID = `0x${randomBytes(32).toString("hex")}`;

if (kind === "checkout" || kind === "treasury") {
  environment.SCENARIO_TERMINAL_KEY = secret("terminal-signer");
  environment.SCENARIO_OPERATIONS_TOKEN = secret(
    process.env.SCENARIO_OPERATIONS_TOKEN_FILE ?? "operations-vendor-v2.token",
  );
}
if (kind === "treasury") {
  // A relayer credential (`provision:vendor-treasury`), distinct from the API operations token.
  const treasury = JSON.parse(
    secret(process.env.SCENARIO_VENDOR_TREASURY_FILE ?? "vendor-treasury-v2.json"),
  );
  if (treasury.eventId !== provisioning.eventId)
    throw new Error("The vendor treasury credential was issued for a different event");
  environment.SCENARIO_VENDOR_TREASURY_TOKEN = treasury.token;
  environment.SCENARIO_VENDOR_AUTHORITY_KEY = secret("vendor-authority");
  environment.SCENARIO_TIME_CONTROL = "chain";
  environment.SCENARIO_EVENT = JSON.stringify({
    eventId: financial.eventId,
    registry: provisioning.registry,
    router: financial.router,
    vault: financial.vault,
    ledger: financial.ledger,
    token: financial.asset,
  });
  // Channel, payment and refund identifiers must be fresh on a public chain.
  environment.SCENARIO_RUN_ID = process.env.SCENARIO_RUN_ID ?? `v2-${Date.now()}`;
  // As short as the registered acceptance and submission bounds allow, since the wait is real.
  environment.SCENARIO_WINDOWS =
    process.env.SCENARIO_WINDOWS ??
    JSON.stringify({ acceptFromSeconds: 30, acceptUntilSeconds: 240, submitUntilSeconds: 300 });
  environment.SCENARIO_PROVISIONED = JSON.stringify({
    vendorId: provisioning.vendorId,
    terminalId: provisioning.terminalId,
    configVersion: provisioning.configVersion,
    destinationVersion: provisioning.destinationVersion,
    organizerFeeBps: provisioning.organizerFeeBps,
    platformFeeBps: provisioning.platformFeeBps,
  });
}

const redact = (text) => text.split(rpcUrl).join("<rpc>");
const child = spawn(
  process.execPath,
  [
    "--network-family-autoselection-attempt-timeout=5000",
    join(root, "packages", "scenario", "dist", "cli.js"),
  ],
  { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.on("data", (chunk) => process.stdout.write(redact(String(chunk))));
child.stderr.on("data", (chunk) => process.stderr.write(redact(String(chunk))));
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
