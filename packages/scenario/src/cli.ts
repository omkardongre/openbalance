import type { Hex } from "viem";
import { runAccountScenario } from "./account-scenario.js";
import { runOfflineReserveScenario } from "./event-scenario.js";
import { runRelayProcessScenario } from "./relay-scenario.js";

const rpcUrl = process.env.SCENARIO_RPC_URL;
const deployerPrivateKey = process.env.SCENARIO_DEPLOYER_PRIVATE_KEY;
const kind = process.env.SCENARIO_KIND ?? "account";
const workspaceRoot = process.env.SCENARIO_WORKSPACE_ROOT ?? process.cwd();

if (!rpcUrl || !deployerPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey)) {
  process.stderr.write(
    "Usage: SCENARIO_RPC_URL=<url> SCENARIO_DEPLOYER_PRIVATE_KEY=<hex> [SCENARIO_KIND=account|offline|relay] node dist/cli.js\n",
  );
  process.exitCode = 64;
} else if (!["account", "offline", "relay"].includes(kind)) {
  process.stderr.write(`Unknown scenario kind: ${kind}\n`);
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
      : kind === "offline"
        ? () => runOfflineReserveScenario(options)
        : () => runAccountScenario(options);
  const label =
    kind === "relay"
      ? "relay-process"
      : kind === "offline"
        ? "offline-reserve"
        : "account-ownership";
  run().then(
    (result) =>
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, environment: "local", kind: label, ...result })}\n`,
      ),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Scenario failed"}\n`);
      process.exitCode = 1;
    },
  );
}
