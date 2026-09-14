import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = fileURLToPath(new URL("../contracts/", import.meta.url));

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      shell: false,
      env: process.env,
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
        : reject(new Error(`${command} failed: ${stderr.slice(-500)}`)),
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await capture("cast", ["chain-id", "--rpc-url", rpcUrl])) === "31337") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local Anvil RPC did not become ready");
}

async function deploy(contract, rpcUrl, privateKey, constructorArgs = []) {
  const output = await capture(
    "forge",
    [
      "create",
      "--rpc-url",
      rpcUrl,
      "--private-key",
      privateKey,
      "--broadcast",
      "--json",
      contract,
      ...constructorArgs,
    ],
    { cwd: contracts },
  );
  const result = JSON.parse(output);
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(result.deployedTo) ||
    !/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash)
  )
    throw new Error("Local deployment did not return canonical references");
  return result;
}

const port = await availablePort();
const rpcUrl = `http://127.0.0.1:${port}`;
const wallet = JSON.parse(await capture("cast", ["wallet", "new-mnemonic", "--json"]));
const mnemonic = wallet.data?.mnemonic;
const deployer = wallet.data?.accounts?.[0]?.address;
const privateKeyHex = wallet.data?.accounts?.[0]?.private_key;
if (
  typeof mnemonic !== "string" ||
  !/^0x[0-9a-fA-F]{40}$/.test(deployer) ||
  !/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex)
)
  throw new Error("Ephemeral local deployment key generation failed");
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

try {
  await waitForRpc(rpcUrl);
  await capture("forge", ["build"], { cwd: contracts });
  const token = await deploy("src/test/LocalTestToken.sol:LocalTestToken", rpcUrl, privateKeyHex, [
    "--constructor-args",
    deployer,
    "1000000000000",
  ]);
  const factory = await deploy("src/payments/EventFactory.sol:EventFactory", rpcUrl, privateKeyHex);
  const eventId = await capture("cast", ["keccak", "openbalance:local:verification"]);
  const sent = JSON.parse(
    await capture("cast", [
      "send",
      "--json",
      "--rpc-url",
      rpcUrl,
      "--private-key",
      privateKeyHex,
      factory.deployedTo,
      "deployEvent(bytes32,address,address,uint16)",
      eventId,
      token.deployedTo,
      deployer,
      "500",
    ]),
  );
  if (sent.status !== "0x1") throw new Error("Local event deployment reverted");
  const deployment = await capture("cast", [
    "call",
    "--rpc-url",
    rpcUrl,
    factory.deployedTo,
    "getDeployment(address,bytes32)((address,address,address,address))",
    deployer,
    eventId,
  ]);
  const addresses = deployment.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (addresses.length !== 4 || new Set(addresses.map((value) => value.toLowerCase())).size !== 4)
    throw new Error("Local event components are incomplete or aliased");
  for (const address of [token.deployedTo, factory.deployedTo, ...addresses]) {
    const code = await capture("cast", ["code", "--rpc-url", rpcUrl, address]);
    if (code === "0x") throw new Error("Local deployment has missing bytecode");
  }
  const decimals = await capture("cast", [
    "call",
    "--rpc-url",
    rpcUrl,
    token.deployedTo,
    "decimals()(uint8)",
  ]);
  if (decimals !== "6") throw new Error("Local asset decimal verification failed");
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      environment: "local",
      chainId: 31337,
      eventId,
      deploymentBlock: Number.parseInt(sent.blockNumber, 16),
      token: token.deployedTo,
      factory: factory.deployedTo,
      registry: addresses[0],
      ledger: addresses[1],
      router: addresses[2],
      vault: addresses[3],
      transactionHash: sent.transactionHash,
      limitations: ["Ephemeral Anvil deployment with an explicitly labelled local test asset."],
    })}\n`,
  );
} finally {
  if (anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((resolve) => anvil.once("exit", resolve));
  }
}
