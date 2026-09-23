// Measures how much parallelism the payment path can receive, by conflict graph rather than by load.
//
// This is the companion to `measure-contention.mjs` and supersedes it as the primary evidence. A
// load test cannot attribute anything below saturation — Monad re-executes a conflicting transaction
// and still commits it in the same block — and saturating a public network costs more gas than a
// hackathon budget holds. The conflict structure, by contrast, is a static property of which storage
// slots the payments touch, so simulating them recovers it exactly: no offered load, no saturation,
// and no gas beyond creating and funding the payer accounts.
//
// Runs against a real chain by preference. Boots Anvil when no endpoint is given, which is how the
// harness itself is verified; an Anvil number says nothing about Monad and is labelled accordingly.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeConflictGraph } from "./contention-graph.mjs";
import { decryptKeystore } from "./keystore.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = fileURLToPath(new URL("../contracts/", import.meta.url));
const scenarioCli = fileURLToPath(new URL("../packages/scenario/dist/cli.js", import.meta.url));

function capture(command, args, options = {}) {
  return new Promise((resolve_, reject) => {
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
        ? resolve_(stdout.trim())
        : reject(new Error(`${command} failed: ${stderr.slice(-4000)}`)),
    );
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve_, reject) =>
    server.listen(0, "127.0.0.1", resolve_).once("error", reject),
  );
  const { port } = server.address();
  await new Promise((resolve_, reject) =>
    server.close((error) => (error ? reject(error) : resolve_())),
  );
  return port;
}

async function waitForRpc(rpcUrl, expectedChainId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const chainId = await capture("cast", ["chain-id", "--rpc-url", rpcUrl]);
      if (!expectedChainId || chainId === String(expectedChainId)) return Number(chainId);
    } catch {}
    await new Promise((resolve_) => setTimeout(resolve_, 150));
  }
  throw new Error("RPC endpoint did not become ready");
}

const payerCount = Number(process.env.CONFLICT_PAYERS ?? "16");
const outputPath = process.env.CONFLICT_OUTPUT ?? "evidence/contention/conflict-graph.json";
const remoteRpcUrl = process.env.CONFLICT_RPC_URL;
const remoteKeystore = process.env.CONFLICT_DEPLOYER_KEYSTORE ?? process.env.DEPLOYER_KEYSTORE_PATH;
const remoteKeystorePassword =
  process.env.CONFLICT_DEPLOYER_KEYSTORE_PASSWORD_FILE ??
  process.env.DEPLOYER_KEYSTORE_PASSWORD_FILE;
if (!Number.isInteger(payerCount) || payerCount < 2 || payerCount > 500)
  throw new Error("CONFLICT_PAYERS must be an integer between 2 and 500");
if (Boolean(remoteRpcUrl) !== Boolean(remoteKeystore && remoteKeystorePassword))
  throw new Error(
    "A remote run requires CONFLICT_RPC_URL plus a keystore path and password file " +
      "(CONFLICT_DEPLOYER_KEYSTORE / CONFLICT_DEPLOYER_KEYSTORE_PASSWORD_FILE, or the " +
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
else {
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
      // Monad gas and opcode semantics, so a local rehearsal exercises the same code paths as the
      // real target — including the transient-storage opcodes the payment path relies on.
      "--network",
      "monad",
    ],
    { cwd: root, shell: false, stdio: "ignore" },
  );
}

try {
  const chainId = await waitForRpc(rpcUrl, anvil ? 31_337 : undefined);
  const raw = await capture("node", [scenarioCli], {
    cwd: root,
    env: {
      ...process.env,
      SCENARIO_RPC_URL: rpcUrl,
      SCENARIO_DEPLOYER_PRIVATE_KEY: privateKeyHex,
      SCENARIO_RP_ID: "localhost",
      SCENARIO_ORIGIN: "http://localhost:3000",
      SCENARIO_KIND: "contention-graph",
      SCENARIO_PAYER_COUNTS: String(payerCount),
    },
  });
  const run = JSON.parse(raw);
  if (run.kind !== "payment-conflict-graph") throw new Error("Unexpected scenario result");

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ chainId, run }, null, 2)}\n`);
  const report = summarizeConflictGraph(run);
  await writeFile(outputPath, `${JSON.stringify({ chainId, run, report }, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify(
      {
        passed: true,
        chainId,
        // Named so a reader cannot mistake a local rehearsal for a statement about Monad.
        monadExecutionSemantics: chainId !== 31_337,
        contractCodeHash: report.contractCodeHash,
        ledger: run.ledger,
        baseBlockNumber: run.baseBlockNumber,
        paymentGasEstimate: run.paymentGasEstimate,
        payments: report.transactions,
        sharedWrittenSlotCount: report.sharedWrittenSlotCount,
        sharedWrittenSlots: report.sharedWrittenSlots,
        conflicts: report.conflicts,
        executionWaves: report.executionWaves,
        theoreticalSpeedup: report.theoreticalSpeedup,
        parallelismScore: report.parallelismScore,
        stateContentionIndex: report.stateContentionIndex,
        idealSpeedupBound: report.idealSpeedupBound,
        outputPath,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (anvil && anvil.exitCode === null) {
    anvil.kill("SIGTERM");
    await new Promise((resolve_) => anvil.once("exit", resolve_));
  }
}
