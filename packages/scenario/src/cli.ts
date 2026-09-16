import type { Hex } from "viem";
import { runAccountScenario } from "./account-scenario.js";
import { runOfflineReserveScenario } from "./event-scenario.js";
import { runFaucetScenario } from "./faucet-scenario.js";
import { runRelayProcessScenario } from "./relay-scenario.js";

const rpcUrl = process.env.SCENARIO_RPC_URL;
const deployerPrivateKey = process.env.SCENARIO_DEPLOYER_PRIVATE_KEY;
const databaseUrl = process.env.SCENARIO_DATABASE_URL;
const kind = process.env.SCENARIO_KIND ?? "account";
const workspaceRoot = process.env.SCENARIO_WORKSPACE_ROOT ?? process.cwd();
const kinds = ["account", "offline", "relay", "faucet"];
const labels: Record<string, string> = {
  account: "account-ownership",
  offline: "offline-reserve",
  relay: "relay-process",
  faucet: "faucet",
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
} else {
  const options = {
    rpcUrl,
    deployerPrivateKey: deployerPrivateKey as Hex,
    ...(process.env.SCENARIO_RP_ID ? { rpId: process.env.SCENARIO_RP_ID } : {}),
    ...(process.env.SCENARIO_ORIGIN ? { origin: process.env.SCENARIO_ORIGIN } : {}),
  };
  const run =
    kind === "relay"
      ? () => runRelayProcessScenario({ ...options, workspaceRoot })
      : kind === "faucet"
        ? () => runFaucetScenario({ ...options, databaseUrl: databaseUrl as string })
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
