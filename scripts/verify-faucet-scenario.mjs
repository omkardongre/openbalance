import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = fileURLToPath(new URL("../contracts/", import.meta.url));
const scenarioCli = fileURLToPath(new URL("../packages/scenario/dist/cli.js", import.meta.url));
const container = `openbalance-faucet-${randomBytes(8).toString("hex")}`;
const password = randomBytes(32).toString("hex");

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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

let created = false;
let anvil;
try {
  await capture(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=openbalance_faucet",
      "--health-cmd",
      "pg_isready -U postgres -d openbalance_faucet",
      "--health-interval",
      "1s",
      "--health-timeout",
      "2s",
      "--health-retries",
      "30",
      "postgres:16-alpine",
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  created = true;
  let ready = false;
  let lastState = "unknown";
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    try {
      lastState = await capture("docker", [
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        container,
      ]);
    } catch (error) {
      lastState = error instanceof Error ? error.message : "inspect failed";
    }
    if (lastState === "healthy") ready = true;
    else if (lastState === "unhealthy") break;
    else await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!ready) {
    const logs = await capture("docker", ["logs", "--tail", "20", container]).catch((error) =>
      error instanceof Error ? error.message : "logs unavailable",
    );
    throw new Error(`Disposable PostgreSQL did not become ready (${lastState}): ${logs}`);
  }
  const binding = await capture("docker", ["port", container, "5432/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("Unexpected database binding");
  const databaseUrl = `postgresql://postgres:${password}@${binding}/openbalance_faucet`;

  await capture("forge", ["build"], { cwd: contracts });
  await capture("pnpm", ["--filter", "@openbalance/api", "build"], { cwd: root });
  await capture("pnpm", ["--filter", "@openbalance/scenario", "build"], { cwd: root });
  await capture("pnpm", ["--filter", "@openbalance/api", "migrate"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  const port = await availablePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const wallet = JSON.parse(await capture("cast", ["wallet", "new-mnemonic", "--json"]));
  const mnemonic = wallet.data?.mnemonic;
  const privateKeyHex = wallet.data?.accounts?.[0]?.private_key;
  if (typeof mnemonic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex))
    throw new Error("Ephemeral scenario key generation failed");
  anvil = spawn(
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
  await waitForRpc(rpcUrl);

  const output = await capture("node", [scenarioCli], {
    cwd: root,
    env: {
      ...process.env,
      SCENARIO_RPC_URL: rpcUrl,
      SCENARIO_DEPLOYER_PRIVATE_KEY: privateKeyHex,
      SCENARIO_DATABASE_URL: databaseUrl,
      SCENARIO_KIND: "faucet",
    },
  });
  const result = JSON.parse(output);
  if (result.kind !== "faucet") throw new Error("Unexpected faucet scenario result");
  if (result.attendeeBalance !== result.fundedUnits)
    throw new Error("Faucet did not credit the exact amount");
  if (
    result.overMaxRejected !== true ||
    result.accountCapEnforced !== true ||
    result.dailyCapEnforced !== true
  )
    throw new Error("Faucet limits were not enforced on chain and in the ledger");
  process.stdout.write(`${JSON.stringify({ passed: true, ...result })}\n`);
} finally {
  if (anvil && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((resolve) => anvil.once("exit", resolve));
  }
  if (created) await capture("docker", ["rm", "--force", "--volumes", container]).catch(() => {});
}
