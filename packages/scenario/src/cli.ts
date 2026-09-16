import type { Hex } from "viem";
import { runAccountScenario } from "./account-scenario.js";

const rpcUrl = process.env.SCENARIO_RPC_URL;
const deployerPrivateKey = process.env.SCENARIO_DEPLOYER_PRIVATE_KEY;

if (!rpcUrl || !deployerPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey)) {
  process.stderr.write(
    "Usage: SCENARIO_RPC_URL=<url> SCENARIO_DEPLOYER_PRIVATE_KEY=<hex> node dist/cli.js\n",
  );
  process.exitCode = 64;
} else {
  runAccountScenario({
    rpcUrl,
    deployerPrivateKey: deployerPrivateKey as Hex,
    ...(process.env.SCENARIO_RP_ID ? { rpId: process.env.SCENARIO_RP_ID } : {}),
    ...(process.env.SCENARIO_ORIGIN ? { origin: process.env.SCENARIO_ORIGIN } : {}),
  }).then(
    (result) =>
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          environment: "local",
          kind: "account-ownership",
          ...result,
        })}\n`,
      ),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Scenario failed"}\n`);
      process.exitCode = 1;
    },
  );
}
