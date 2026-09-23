import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeContention } from "./contention-metrics.mjs";
import { decryptKeystore } from "./keystore.mjs";

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
        : reject(new Error(`${command} failed: ${stderr.slice(-2000)}`)),
    );
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForRpc(rpcUrl, expectedChainId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const chainId = await capture("cast", ["chain-id", "--rpc-url", rpcUrl]);
      if (!expectedChainId || chainId === String(expectedChainId)) return Number(chainId);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("RPC endpoint did not become ready");
}

/**
 * Offered-load tiers, run smallest first as independent bursts.
 *
 * A series rather than one burst because occupancy alone cannot attribute contention: optimistic
 * execution re-executes a conflicting transaction and still commits it in the same block, so any
 * load the node can absorb looks identical whether or not the workload conflicts. The difference
 * appears only where the mined rate stops tracking the offered rate, which requires crossing that
 * point from below.
 */
const tiers = (process.env.CONTENTION_TIERS ?? "10,25,50")
  .split(",")
  .map((value) => Number(value.trim()));
const outputPath = process.env.CONTENTION_OUTPUT ?? "evidence/contention/latest.json";
const remoteRpcUrl = process.env.CONTENTION_RPC_URL;
const remoteKeystore =
  process.env.CONTENTION_DEPLOYER_KEYSTORE ?? process.env.DEPLOYER_KEYSTORE_PATH;
const remoteKeystorePassword =
  process.env.CONTENTION_DEPLOYER_KEYSTORE_PASSWORD_FILE ??
  process.env.DEPLOYER_KEYSTORE_PASSWORD_FILE;
if (
  tiers.length === 0 ||
  tiers.some((value) => !Number.isInteger(value) || value < 2 || value > 500) ||
  tiers.some((value, index) => index > 0 && value <= tiers[index - 1])
)
  throw new Error("CONTENTION_TIERS must be strictly increasing integers between 2 and 500");
if (Boolean(remoteRpcUrl) !== Boolean(remoteKeystore && remoteKeystorePassword))
  throw new Error(
    "A remote run requires CONTENTION_RPC_URL plus a keystore path and password file " +
      "(CONTENTION_DEPLOYER_KEYSTORE / CONTENTION_DEPLOYER_KEYSTORE_PASSWORD_FILE, or the " +
      "DEPLOYER_KEYSTORE_PATH / DEPLOYER_KEYSTORE_PASSWORD_FILE pair used by the deploy scripts)",
  );

await capture("forge", ["build"], { cwd: contracts });
await capture("pnpm", ["--filter", "@openbalance/scenario", "build"], { cwd: root });

let anvil;
let rpcUrl = remoteRpcUrl;
let privateKeyHex;
if (rpcUrl)
  privateKeyHex = await decryptKeystore({
    keystorePath: resolve(root, remoteKeystore),
    passwordPath: resolve(root, remoteKeystorePassword),
    keccak256: (hex) => capture("cast", ["keccak", hex]),
  });
if (!rpcUrl) {
  const port = await availablePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  const wallet = JSON.parse(await capture("cast", ["wallet", "new-mnemonic", "--json"]));
  const mnemonic = wallet.data?.mnemonic;
  privateKeyHex = wallet.data?.accounts?.[0]?.private_key;
  if (typeof mnemonic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKeyHex))
    throw new Error("Ephemeral measurement key generation failed");
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
      "100000",
    ],
    { cwd: root, shell: false, stdio: "ignore" },
  );
}

/**
 * Refuses a run the deployer cannot pay for, before any MON moves.
 *
 * Monad charges the declared gas limit rather than the gas used, so an abort partway through setup
 * has already spent nearly what completing it would have, and produced no evidence for it. The only
 * cheap failure is the one that happens before the first transaction.
 *
 * The estimate mirrors the scenario's own funding arithmetic: per payer, one account creation, one
 * token transfer, one value send, and the sponsor float sized at the bid price. Deployment of the
 * event, factories and token is added as a flat allowance on top. Priced at the bid rather than the
 * effective fee because that is what Reserve Balance requires the sender to hold.
 *
 * @see https://docs.monad.xyz/developer-essentials/gas-on-monad
 * @see https://docs.monad.xyz/developer-essentials/reserve-balance
 */
async function preflightBudget(rpcUrl) {
  const address = await capture("cast", ["wallet", "address", "--private-key", privateKeyHex]);
  const [balanceRaw, baseFeeRaw] = await Promise.all([
    capture("cast", ["balance", address, "--rpc-url", rpcUrl]),
    capture("cast", ["base-fee", "--rpc-url", rpcUrl]).catch(() => "0"),
  ]);
  const balance = BigInt(balanceRaw.trim());
  const baseFee = BigInt(baseFeeRaw.trim());
  // Mirrors BASE_FEE_MULTIPLIER and PRIORITY_FEE_WEI in the scenario.
  const priority = 1_000_000_000n;
  const bid = baseFee > 0n ? baseFee * 2n + priority : BigInt(await capture("cast", ["gas-price", "--rpc-url", rpcUrl]));

  const perPayerGas = 500_000n + 100_000n + 30_000n;
  const sponsorFloat = ((1_000_000n + 21_000n) * bid * 11n) / 10n;
  // Every tier builds a fresh set of payers, so the payer cost is the sum across tiers, not the
  // widest one. Only the event deployment is shared.
  const required =
    BigInt(totalPayers) * (perPayerGas * bid + sponsorFloat) + DEPLOYMENT_GAS_ALLOWANCE * bid;

  if (balance >= required) return { address, balance, required, bid };
  throw new Error(
    `Insufficient balance to run this measurement. ${address} holds ` +
      `${formatMon(balance)} MON but the run needs about ${formatMon(required)} MON ` +
      `(${totalPayers} payers across tiers ${tiers.join(",")} at a ${formatGwei(bid)} gwei bid). ` +
      "Nothing has been spent. Either fund the deployer or lower CONTENTION_TIERS — note that " +
      "measure-conflict-graph.mjs produces the primary parallelism evidence for a small fraction " +
      "of this, because it simulates the payments instead of broadcasting them.",
  );
}

const formatMon = (wei) => (Number(wei) / 1e18).toFixed(3);
const formatGwei = (wei) => (Number(wei) / 1e9).toFixed(0);
/** Flat allowance for the token, event factory, event contracts and account factory deployments. */
const DEPLOYMENT_GAS_ALLOWANCE = 20_000_000n;
const totalPayers = tiers.reduce((sum, tier) => sum + tier, 0);

try {
  const chainId = await waitForRpc(rpcUrl, anvil ? 31_337 : undefined);
  // Local Anvil accounts are funded by the harness itself, so the check only binds on a real chain.
  const budget = anvil ? undefined : await preflightBudget(rpcUrl);
  if (budget)
    process.stderr.write(
      `preflight: deployer ${budget.address} holds ${formatMon(budget.balance)} MON, ` +
        `run needs about ${formatMon(budget.required)} MON\n`,
    );
  const raw = await capture("node", [scenarioCli], {
    cwd: root,
    env: {
      ...process.env,
      SCENARIO_RPC_URL: rpcUrl,
      SCENARIO_DEPLOYER_PRIVATE_KEY: privateKeyHex,
      SCENARIO_RP_ID: "localhost",
      SCENARIO_ORIGIN: "http://localhost:3000",
      SCENARIO_KIND: "contention",
      SCENARIO_PAYER_COUNTS: tiers.join(","),
    },
  });
  const run = JSON.parse(raw);
  if (run.kind !== "payment-contention") throw new Error("Unexpected scenario result");

  // The raw observations land on disk before any aggregation, so a run that cannot be summarized —
  // an all-reverting tier, most likely a gas limit set too low — is still diagnosable.
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ chainId, run }, null, 2)}\n`);

  const reports = run.tiers.map((tier) => summarizeContention(tier));
  await writeFile(outputPath, `${JSON.stringify({ chainId, run, reports }, null, 2)}\n`);

  // A reverted payment is charged and mined but writes nothing, so it neither touches a contended
  // slot nor belongs in a throughput figure. One is enough to disqualify the run as evidence.
  const reverted = reports.reduce((total, report) => total + report.reverted, 0);
  process.stdout.write(
    `${JSON.stringify(
      {
        passed: reverted === 0,
        chainId,
        // Named so a reader cannot mistake a local run for evidence about parallel execution.
        parallelExecutionObservable: run.serialExecutionChain !== true,
        contractCodeHash: run.contractCodeHash,
        ledger: run.ledger,
        paymentGasLimit: run.paymentGasLimit,
        reverted,
        tiers: reports.map((report) => ({
          offered: report.offered,
          settled: report.settled,
          reverted: report.reverted,
          settledPerSecond: report.settledPerSecond,
          settledBlocks: report.settledBlocks,
          maxSettledInOneBlock: report.settledPerSettledBlock.max,
          maxGasUtilization: report.maxGasUtilizationAcrossOccupiedBlocks,
        })),
        outputPath,
      },
      null,
      2,
    )}\n`,
  );
  if (reverted > 0)
    throw new Error(
      `${reverted} payment(s) reverted, so this run is not valid contention evidence; ` +
        `inspect ${outputPath}`,
    );
} finally {
  if (anvil && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((resolve) => anvil.once("exit", resolve));
  }
}
