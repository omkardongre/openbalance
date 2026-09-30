// Attendee side of an offline sale against a reserve channel opened by the treasury journey.
//
//   node scripts/attendee-sign.mjs <request-or-receipt> [--adb]
//
// The argument is an `obqr1:` payment request, a terminal receipt JSON, or a PNG containing either
// as a QR code. With --adb the input is instead a fresh screenshot of the connected terminal.
// A request is checked against the channel as finalized onchain, signed with the channel key
// (re-derived from the run id in secrets/testnet/device-channel.json, never stored), and the response
// QR is written to secrets/testnet/attendee-response.png for the terminal to scan.
//
// The RPC URL embeds a provider key, so it is passed through the environment and redacted from
// anything the child prints.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const secrets = join(root, "secrets", "testnet");
const deployments = join(root, "deployments", "testnet");

const args = process.argv.slice(2);
const fromAdb = args.includes("--adb");
let input = args.find((arg) => arg !== "--adb");
if (!fromAdb && !input) {
  process.stderr.write("Usage: attendee-sign.mjs <request|receipt|png> | --adb\n");
  process.exit(64);
}
if (fromAdb) {
  input = join(secrets, "terminal-screen.png");
  // Binary-safe capture; `adb shell screencap` would translate line endings.
  writeFileSync(
    input,
    execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }),
    {
      mode: 0o600,
    },
  );
}

process.loadEnvFile(process.env.OPENBALANCE_ENV_FILE ?? join(root, ".env.testnet"));
const rpcUrl = process.env.ACCOUNT_RPC_URL;
if (!rpcUrl?.startsWith("https://")) throw new Error("ACCOUNT_RPC_URL must be an https URL");

const channel = JSON.parse(readFileSync(join(secrets, "device-channel.json"), "utf8"));
const provisioning = JSON.parse(readFileSync(join(deployments, "event-provisioning.json"), "utf8"));
const terminal = JSON.parse(
  readFileSync(join(deployments, "device-terminal-provisioning.json"), "utf8"),
);
const financial = JSON.parse(
  readFileSync(join(deployments, "financial-manifest.json"), "utf8"),
).events.find((event) => event.eventId === provisioning.eventId);
if (!financial) throw new Error("financial-manifest.json does not contain the provisioned event");

const environment = {
  ...process.env,
  SCENARIO_KIND: "attendee-sign",
  SCENARIO_RPC_URL: rpcUrl,
  SCENARIO_STATE_PATH: join(secrets, `attendee-wallet-${channel.runId}.json`),
  SCENARIO_RUN_ID: channel.runId,
  SCENARIO_VAULT: financial.vault,
  SCENARIO_REGISTRY: provisioning.registry,
  SCENARIO_VENDOR_NAME: terminal.vendorName,
  SCENARIO_INPUT: input,
  SCENARIO_RESPONSE_PNG: join(secrets, "attendee-response.png"),
};

const redact = (text) => text.split(rpcUrl).join("<rpc>");
const child = spawn(process.execPath, [join(root, "packages", "scenario", "dist", "cli.js")], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(redact(String(chunk))));
child.stderr.on("data", (chunk) => process.stderr.write(redact(String(chunk))));
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
