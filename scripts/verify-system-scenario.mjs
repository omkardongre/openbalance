import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = fileURLToPath(new URL("../contracts/", import.meta.url));
const scenarioCli = fileURLToPath(new URL("../packages/scenario/dist/cli.js", import.meta.url));
const container = `openbalance-system-${randomBytes(8).toString("hex")}`;
const password = randomBytes(32).toString("hex");
const children = [];
let anvil;

function run(command, args, options = {}) {
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
        : reject(new Error(`${command} failed: ${stderr.slice(-600)}`)),
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

async function waitFor(description, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
      lastError = "not ready";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "probe failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description} did not become ready: ${lastError}`);
}

async function healthy(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  return response.ok;
}

function start(name, entrypoint, env) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.name = name;
  child.stdout.on("data", (value) => {
    child.log = `${child.log ?? ""}${value}`.slice(-2000);
  });
  child.stderr.on("data", (value) => {
    child.log = `${child.log ?? ""}${value}`.slice(-2000);
  });
  children.push(child);
  return child;
}

let created = false;
try {
  await run(
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
      "POSTGRES_DB=openbalance_system",
      "--health-cmd",
      "pg_isready -U postgres -d openbalance_system",
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
  await waitFor(
    "PostgreSQL",
    async () => {
      const state = await run("docker", [
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        container,
      ]);
      return state === "healthy";
    },
    60_000,
  );
  const binding = await run("docker", ["port", container, "5432/tcp"]);
  const databaseUrl = `postgresql://postgres:${password}@${binding}/openbalance_system`;

  await run("forge", ["build"], { cwd: contracts });
  await run("pnpm", ["--filter", "@openbalance/scenario", "build"]);
  await run("pnpm", ["--filter", "@openbalance/api", "build"]);
  await run("pnpm", ["--filter", "@openbalance/venue-relay", "build"]);
  await run("pnpm", ["--filter", "@openbalance/relayer", "build"]);
  await run("pnpm", ["--filter", "@openbalance/indexer", "build"]);
  for (const service of ["indexer", "api", "relayer", "integrations"]) {
    await run("pnpm", ["--filter", `@openbalance/${service}`, "migrate"], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        INDEXER_DATABASE_URL: databaseUrl,
        INTEGRATION_DATABASE_URL: databaseUrl,
      },
    });
  }

  const rpcPort = await availablePort();
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const wallet = JSON.parse(await run("cast", ["wallet", "new-mnemonic", "--json"]));
  const mnemonic = wallet.data?.mnemonic;
  const deployer = wallet.data?.accounts?.[0];
  if (typeof mnemonic !== "string" || !deployer?.private_key)
    throw new Error("Ephemeral system key generation failed");
  const faucetWallet = JSON.parse(await run("cast", ["wallet", "new", "--json"]));
  const faucet = Array.isArray(faucetWallet.data) ? faucetWallet.data[0] : faucetWallet.data;
  if (!faucet?.private_key || !faucet?.address)
    throw new Error("Ephemeral faucet key generation failed");
  anvil = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(rpcPort),
      "--chain-id",
      "31337",
      "--silent",
      "--mnemonic",
      mnemonic,
      "--balance",
      "1000",
    ],
    { cwd: root, stdio: "ignore" },
  );
  await waitFor(
    "Anvil",
    async () => (await run("cast", ["chain-id", "--rpc-url", rpcUrl])) === "31337",
  );

  await run("cast", [
    "send",
    "--rpc-url",
    rpcUrl,
    "--private-key",
    deployer.private_key,
    faucet.address,
    "--value",
    "10ether",
  ]);
  const create = async (contract, args = []) => {
    const result = JSON.parse(
      await run(
        "forge",
        [
          "create",
          "--json",
          "--broadcast",
          "--rpc-url",
          rpcUrl,
          "--private-key",
          deployer.private_key,
          contract,
          ...args,
        ],
        { cwd: contracts },
      ),
    );
    if (!result.deployedTo) throw new Error(`${contract} deployment failed`);
    return result.deployedTo;
  };
  const token = await create("src/test/LocalTestToken.sol:LocalTestToken", [
    "--constructor-args",
    deployer.address,
    "1000000000000",
  ]);
  const factory = await create("src/accounts/AccountFactory.sol:AccountFactory");
  const eventFactory = await create("src/payments/EventFactory.sol:EventFactory");
  for (const [label, address] of [
    ["token", token],
    ["factory", factory],
    ["eventFactory", eventFactory],
  ]) {
    const code = await run("cast", ["code", "--rpc-url", rpcUrl, address]);
    if (!code || code === "0x") throw new Error(`${label} has no code at ${address}`);
  }
  const eventId = await run("cast", ["keccak", "openbalance:system"]);
  await run("cast", [
    "send",
    "--rpc-url",
    rpcUrl,
    "--private-key",
    deployer.private_key,
    eventFactory,
    "deployEvent(bytes32,address,address,uint16)",
    eventId,
    token,
    deployer.address,
    "500",
  ]);
  const deployment = await run("cast", [
    "call",
    "--rpc-url",
    rpcUrl,
    eventFactory,
    "getDeployment(address,bytes32)((address,address,address,address))",
    deployer.address,
    eventId,
  ]);
  const [registry, ledger, router, vault] = deployment.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (!registry || !ledger || !router || !vault) throw new Error("Event deployment is incomplete");
  await run("cast", [
    "send",
    "--rpc-url",
    rpcUrl,
    "--private-key",
    deployer.private_key,
    token,
    "transfer(address,uint256)",
    faucet.address,
    "100000000",
  ]);
  const implementation = await run("cast", [
    "call",
    "--rpc-url",
    rpcUrl,
    factory,
    "implementation()(address)",
  ]);
  const factoryCodeHash = await run("cast", [
    "keccak",
    await run("cast", ["code", "--rpc-url", rpcUrl, factory]),
  ]);
  const implementationCodeHash = await run("cast", [
    "keccak",
    await run("cast", ["code", "--rpc-url", rpcUrl, implementation]),
  ]);

  const directory = await mkdtemp(join(tmpdir(), "openbalance-system-"));
  const manifestPath = join(directory, "account-manifest.json");
  const faucetKeyPath = join(directory, "faucet.key");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      chainId: 31337,
      factory,
      factoryCodeHash,
      implementation,
      implementationCodeHash,
    }),
  );
  await writeFile(faucetKeyPath, faucet.private_key);
  await chmod(faucetKeyPath, 0o600);

  const apiPort = await availablePort();
  const relayerPort = await availablePort();
  const indexerPort = await availablePort();
  const indexerMetricsPort = await availablePort();
  const relayPort = await availablePort();

  start("api", "services/api/dist/server.js", {
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    DATABASE_URL: databaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGIN: "http://localhost:3000",
    ACCOUNT_MANIFEST_PATH: manifestPath,
    ACCOUNT_RPC_URL: rpcUrl,
    ACCOUNT_FINALITY_TAG: "latest",
    PROJECTION_READS_ENABLED: "true",
    FAUCET_RPC_URL: rpcUrl,
    FAUCET_CHAIN_ID: "31337",
    FAUCET_CHAIN_NAME: "Local Anvil",
    FAUCET_TOKEN_ADDRESS: token,
    FAUCET_TOKEN_DECIMALS: "6",
    FAUCET_PRIVATE_KEY_PATH: faucetKeyPath,
    FAUCET_MAX_AMOUNT: "5000000",
    FAUCET_DAILY_LIMIT: "50000000",
    METRICS_PORT: String(await availablePort()),
  });
  start("relayer", "services/relayer/dist/server.js", {
    HOST: "127.0.0.1",
    PORT: String(relayerPort),
    DATABASE_URL: databaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGIN: "http://localhost:3000",
    ACCOUNT_MANIFEST_PATH: manifestPath,
    ACCOUNT_RPC_URL: rpcUrl,
    ACCOUNT_FINALITY_TAG: "latest",
    SPONSOR_PRIVATE_KEY_PATH: faucetKeyPath,
    SPONSOR_DAILY_DEPLOYMENTS: "100",
    SPONSOR_MAX_DEPLOYMENT_GAS: "1000000",
    SPONSOR_MAX_FEE_PER_GAS_WEI: "1000000000",
    SPONSOR_MAX_COST_WEI: "1000000000000000",
  });
  start("indexer", "services/indexer/dist/server.js", {
    INDEXER_DATABASE_URL: databaseUrl,
    INDEXER_RPC_URL: rpcUrl,
    INDEXER_CHAIN_ID: "31337",
    INDEXER_CHAIN_NAME: "Local Anvil",
    INDEXER_EVENT_ID: eventId,
    INDEXER_ROUTER_ADDRESS: router,
    INDEXER_LEDGER_ADDRESS: ledger,
    INDEXER_VAULT_ADDRESS: vault,
    INDEXER_DEPLOYMENT_BLOCK: "0",
    INDEXER_ENVIRONMENT: "local",
    INDEXER_FINALITY_TAG: "latest",
    METRICS_PORT: String(indexerMetricsPort),
  });
  const relayKeyPath = join(directory, "relay.key");
  const snapshotPath = join(directory, "terminals.json");
  await writeFile(relayKeyPath, randomBytes(32).toString("hex"));
  await writeFile(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 1,
      chainId: 31337,
      registry,
      vault,
      finalizedBlockNumber: "0",
      finalizedBlockHash: `0x${"11".repeat(32)}`,
      generatedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      terminals: [
        {
          terminalId: `0x${"22".repeat(32)}`,
          keyVersion: "1",
          channelId: `0x${"33".repeat(32)}`,
          signer: deployer.address,
          enabled: true,
          validAfter: Math.floor(Date.now() / 1000) - 60,
          validUntil: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    }),
  );
  start("venue-relay", "services/venue-relay/dist/server.js", {
    HOST: "127.0.0.1",
    PORT: String(relayPort),
    VENUE_RELAY_DATABASE_PATH: join(directory, "relay.sqlite"),
    VENUE_RELAY_KEY_PATH: relayKeyPath,
    TERMINAL_SNAPSHOT_PATH: snapshotPath,
    TERMINAL_INGRESS_AUDIENCE: `http://127.0.0.1:${relayPort}/v1/vouchers`,
  });

  try {
    await waitFor("API", () => healthy(`http://127.0.0.1:${apiPort}/health/ready`));
    await waitFor("relayer", () => healthy(`http://127.0.0.1:${relayerPort}/health/live`));
    await waitFor("indexer", () => healthy(`http://127.0.0.1:${indexerMetricsPort}/metrics`));
    await waitFor("venue-relay", () => healthy(`http://127.0.0.1:${relayPort}/health`));
  } catch (error) {
    for (const child of children)
      if (child.log) process.stderr.write(`${child.name}: ${child.log}\n`);
    throw error;
  }

  const output = await run("node", [scenarioCli], {
    env: {
      ...process.env,
      SCENARIO_KIND: "api",
      SCENARIO_API_URL: `http://127.0.0.1:${apiPort}`,
      SCENARIO_RPC_URL: rpcUrl,
      SCENARIO_DEPLOYER_PRIVATE_KEY: deployer.private_key,
      SCENARIO_RP_ID: "localhost",
      SCENARIO_ORIGIN: "http://localhost:3000",
    },
  });
  const result = JSON.parse(output);
  if (result.kind !== "api-journey") throw new Error("Unexpected api scenario result");
  if (result.fundedUnits !== "5000000") throw new Error("Faucet did not grant the expected amount");
  process.stdout.write(
    `${JSON.stringify({ passed: true, processes: ["postgres", "api", "relayer", "indexer", "venue-relay"], ...result })}\n`,
  );
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (anvil && anvil.exitCode === null) anvil.kill("SIGTERM");
  if (created) await run("docker", ["rm", "--force", "--volumes", container]).catch(() => {});
}
