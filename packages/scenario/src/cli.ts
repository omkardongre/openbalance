import type { Hex } from "viem";
import { runAccountScenario } from "./account-scenario.js";
import { runApiEnrollment, runApiFunding, runApiScenario } from "./api-scenario.js";
import { runOfflineReserveScenario } from "./event-scenario.js";
import { runFaucetScenario } from "./faucet-scenario.js";
import { runRelayProcessScenario } from "./relay-scenario.js";
import { runTreasuryScenario } from "./treasury-scenario.js";

const rpcUrl = process.env.SCENARIO_RPC_URL;
const deployerPrivateKey = process.env.SCENARIO_DEPLOYER_PRIVATE_KEY;
const databaseUrl = process.env.SCENARIO_DATABASE_URL;
const apiUrl = process.env.SCENARIO_API_URL;
const statePath = process.env.SCENARIO_STATE_PATH;
const kind = process.env.SCENARIO_KIND ?? "account";
const workspaceRoot = process.env.SCENARIO_WORKSPACE_ROOT ?? process.cwd();
const kinds = [
  "account",
  "offline",
  "relay",
  "faucet",
  "api",
  "api-enroll",
  "api-fund",
  "treasury",
];
const labels: Record<string, string> = {
  account: "account-ownership",
  offline: "offline-reserve",
  relay: "relay-process",
  faucet: "faucet",
  api: "api-journey",
  "api-enroll": "api-enrollment",
  "api-fund": "api-funding",
  treasury: "treasury",
};

if (!rpcUrl || !deployerPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey)) {
  process.stderr.write(
    "Usage: SCENARIO_RPC_URL=<url> SCENARIO_DEPLOYER_PRIVATE_KEY=<hex> [SCENARIO_KIND=account|offline|relay|faucet] node dist/cli.js\n",
  );
  process.exitCode = 64;
} else if (!kinds.includes(kind)) {
  process.stderr.write(`Unknown scenario kind: ${kind}\n`);
  process.exitCode = 64;
} else if (kind === "faucet" && !databaseUrl) {
  process.stderr.write("The faucet scenario requires SCENARIO_DATABASE_URL\n");
  process.exitCode = 64;
} else if (kind === "api" && !apiUrl) {
  process.stderr.write("The api scenario requires SCENARIO_API_URL\n");
  process.exitCode = 64;
} else if ((kind === "api-enroll" || kind === "api-fund") && (!apiUrl || !statePath)) {
  process.stderr.write("The api journey steps require SCENARIO_API_URL and SCENARIO_STATE_PATH\n");
  process.exitCode = 64;
} else if (
  kind === "treasury" &&
  (!apiUrl ||
    !statePath ||
    !process.env.SCENARIO_RELAYER_URL ||
    !process.env.SCENARIO_VENDOR_TREASURY_TOKEN ||
    !process.env.SCENARIO_VENDOR_AUTHORITY_KEY ||
    !process.env.SCENARIO_TERMINAL_KEY ||
    !process.env.SCENARIO_EVENT)
) {
  process.stderr.write(
    "The treasury scenario requires the API, relayer, state and event settings\n",
  );
  process.exitCode = 64;
} else {
  const credentialId = process.env.SCENARIO_CREDENTIAL_ID;
  if (credentialId && !/^0x[0-9a-fA-F]{64}$/.test(credentialId)) {
    process.stderr.write("SCENARIO_CREDENTIAL_ID must be 32 hex bytes\n");
    process.exitCode = 64;
  }
  const options = {
    rpcUrl,
    deployerPrivateKey: deployerPrivateKey as Hex,
    ...(process.env.SCENARIO_RP_ID ? { rpId: process.env.SCENARIO_RP_ID } : {}),
    ...(process.env.SCENARIO_ORIGIN ? { origin: process.env.SCENARIO_ORIGIN } : {}),
    ...(credentialId ? { credentialId: credentialId as Hex } : {}),
  };
  const run =
    kind === "relay"
      ? () => runRelayProcessScenario({ ...options, workspaceRoot })
      : kind === "faucet"
        ? () => runFaucetScenario({ ...options, databaseUrl: databaseUrl as string })
        : kind === "api"
          ? () =>
              runApiScenario({
                ...options,
                apiUrl: apiUrl as string,
                sponsorPrivateKey: deployerPrivateKey as Hex,
              })
          : kind === "api-enroll"
            ? () =>
                runApiEnrollment({
                  ...options,
                  apiUrl: apiUrl as string,
                  sponsorPrivateKey: deployerPrivateKey as Hex,
                  statePath: statePath as string,
                  ...(process.env.SCENARIO_RELAYER_URL
                    ? { relayerUrl: process.env.SCENARIO_RELAYER_URL }
                    : {}),
                })
            : kind === "api-fund"
              ? () =>
                  runApiFunding({
                    ...options,
                    apiUrl: apiUrl as string,
                    sponsorPrivateKey: deployerPrivateKey as Hex,
                    statePath: statePath as string,
                  })
              : kind === "treasury"
                ? () =>
                    runTreasuryScenario({
                      ...options,
                      apiUrl: apiUrl as string,
                      relayerUrl: process.env.SCENARIO_RELAYER_URL as string,
                      statePath: statePath as string,
                      vendorTreasuryToken: process.env.SCENARIO_VENDOR_TREASURY_TOKEN as string,
                      vendorAuthorityPrivateKey: process.env.SCENARIO_VENDOR_AUTHORITY_KEY as Hex,
                      terminalPrivateKey: process.env.SCENARIO_TERMINAL_KEY as Hex,
                      event: JSON.parse(process.env.SCENARIO_EVENT as string),
                      ...(process.env.SCENARIO_RUN_ID
                        ? { runId: process.env.SCENARIO_RUN_ID }
                        : {}),
                      ...(process.env.SCENARIO_TIME_CONTROL === "chain"
                        ? { timeControl: "chain" as const }
                        : {}),
                      ...(process.env.SCENARIO_WINDOWS
                        ? { windows: JSON.parse(process.env.SCENARIO_WINDOWS) }
                        : {}),
                      ...(process.env.SCENARIO_PROVISIONED
                        ? {
                            provisioned: (() => {
                              const raw = JSON.parse(process.env.SCENARIO_PROVISIONED as string);
                              return {
                                vendorId: raw.vendorId as Hex,
                                terminalId: raw.terminalId as Hex,
                                configVersion: BigInt(raw.configVersion),
                                destinationVersion: BigInt(raw.destinationVersion),
                                organizerFeeBps: Number(raw.organizerFeeBps),
                                platformFeeBps: Number(raw.platformFeeBps),
                              };
                            })(),
                          }
                        : {}),
                    })
                : kind === "offline"
                  ? () => runOfflineReserveScenario(options)
                  : () => runAccountScenario(options);
  run().then(
    (result) =>
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, environment: "local", kind: labels[kind], ...result })}\n`,
      ),
    (error: unknown) => {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message || "(no message)"}`
          : "Scenario failed";
      process.stderr.write(`${detail}\n`);
      process.exitCode = 1;
    },
  );
}
