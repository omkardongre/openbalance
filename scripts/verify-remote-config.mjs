// Verifies the remote environment (managed Postgres, Monad testnet RPC providers) is reachable and
// configured correctly before anything is deployed against it. This is a fail-closed probe, not a
// deployment step: it makes no writes, and a missing or wrong-chain provider is a hard failure.
//
// Shells out to `cast` and `psql` rather than importing viem/pg, matching every other root-level
// verification script: this package has no workspace dependency on either client library.
//
// Architecture references: §3.5 (independent verifier RPC), §5.3 (separate testnet manifest/keys),
// §5.5 (external provider dependencies and redundancy).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const MONAD_TESTNET_CHAIN_ID = 10_143n;

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false, env: process.env });
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
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} failed`)),
    );
  });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function checkDatabase() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const startedAt = Date.now();
  const output = await capture("psql", [
    databaseUrl,
    "--no-psqlrc",
    "--tuples-only",
    "--command",
    "select current_database(), version();",
  ]);
  return { ok: true, latencyMs: Date.now() - startedAt, summary: output.split("\n")[0]?.trim() };
}

async function checkRpc(label, url) {
  if (!url) return { label, configured: false };
  const startedAt = Date.now();
  const [chainIdHex, blockHex] = await Promise.all([
    capture("cast", ["chain-id", "--rpc-url", url]),
    capture("cast", ["block-number", "--rpc-url", url]),
  ]);
  const latencyMs = Date.now() - startedAt;
  const chainId = BigInt(chainIdHex);
  if (chainId !== MONAD_TESTNET_CHAIN_ID)
    throw new Error(
      `${label} is not serving Monad testnet: expected chain ${MONAD_TESTNET_CHAIN_ID}, got ${chainId}`,
    );
  return {
    label,
    configured: true,
    ok: true,
    chainId: chainId.toString(),
    blockNumber: blockHex,
    latencyMs,
  };
}

async function main() {
  const results = { database: null, providers: [] };

  results.database = await checkDatabase();

  const operational = await checkRpc("operational", process.env.ACCOUNT_RPC_URL);
  results.providers.push(operational);
  if (!operational.configured) throw new Error("ACCOUNT_RPC_URL is not configured");

  const verifier = await checkRpc("verifier", process.env.VERIFIER_RPC_URL);
  results.providers.push(verifier);
  if (!verifier.configured)
    throw new Error(
      "VERIFIER_RPC_URL is not configured; the verifier's independence claim requires a distinct provider (§3.5)",
    );
  if (process.env.ACCOUNT_RPC_URL === process.env.VERIFIER_RPC_URL)
    throw new Error("ACCOUNT_RPC_URL and VERIFIER_RPC_URL must be different providers");

  process.stdout.write(`${JSON.stringify({ passed: true, ...results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ passed: false, error: error.message })}\n`);
  process.exitCode = 1;
});
