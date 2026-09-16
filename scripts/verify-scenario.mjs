import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = fileURLToPath(new URL("../contracts/", import.meta.url));
const scenarioCli = fileURLToPath(new URL("../packages/scenario/dist/cli.js", import.meta.url));

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      shell: false,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`${command} failed: ${stderr.slice(-800)}`)),
    );
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForRpc(rpcUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await capture("cast", ["chain-id", "--rpc-url", rpcUrl])) === "31337") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local Anvil RPC did not become ready");
}

const port = await availablePort();
const rpcUrl = `http://127.0.0.1:${port}`;
const wallet = JSON.parse(await capture("cast", ["wallet", "new-mnemonic", "--json"]));
const mnemonic = wallet.data?.mnemonic;
const privateKeyHex = wallet.data?.accounts?.[0]?.private_key;
if (typeof mnemonic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex))
  throw new Error("Ephemeral scenario key generation failed");

await capture("forge", ["build"], { cwd: contracts });
await capture("pnpm", ["--filter", "@openbalance/scenario", "build"], { cwd: root });

const anvil = spawn(
  "anvil",
  [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--chain-id",
    "31337",
    "--silent",
    "--mnemonic",
    mnemonic,
    "--balance",
    "1000",
  ],
  { cwd: root, shell: false, stdio: "ignore" },
);

function runScenario(kind) {
  return capture("node", [scenarioCli], {
    cwd: root,
    env: {
      ...process.env,
      SCENARIO_RPC_URL: rpcUrl,
      SCENARIO_DEPLOYER_PRIVATE_KEY: privateKeyHex,
      SCENARIO_RP_ID: "localhost",
      SCENARIO_ORIGIN: "http://localhost:3000",
      SCENARIO_KIND: kind,
    },
  });
}

try {
  await waitForRpc(rpcUrl);
  const account = JSON.parse(await runScenario("account"));
  if (account.kind !== "account-ownership" || account.staleAssertionRejected !== true)
    throw new Error("Account ownership scenario did not prove recovery invalidation");
  if (account.account.toLowerCase() !== account.predictedAccount.toLowerCase())
    throw new Error("Account was not deployed at its predicted address");

  const offline = JSON.parse(await runScenario("offline"));
  if (offline.kind !== "offline-reserve")
    throw new Error("Offline reserve scenario returned an unexpected result");
  for (const field of ["replayRejected", "earlyReclaimRejected", "lateSettlementRejected"]) {
    if (offline[field] !== true) throw new Error(`Offline reserve scenario did not prove ${field}`);
  }
  if (offline.ledgerCustody !== offline.settledUnits)
    throw new Error("Ledger custody does not equal settled gross");

  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      scenarios: [
        { kind: "account-ownership", account: account.account, epoch: account.accountEpoch },
        {
          kind: "offline-reserve",
          channelId: offline.channelId,
          settledUnits: offline.settledUnits,
          reclaimedUnits: offline.reclaimedUnits,
          ledgerCustody: offline.ledgerCustody,
        },
      ],
    })}\n`,
  );
} finally {
  if (anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((resolve) => anvil.once("exit", resolve));
  }
}
