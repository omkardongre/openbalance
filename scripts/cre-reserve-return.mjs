#!/usr/bin/env node
// Operates the scheduled reserve-return workflow (`cre/reserve-return`) against Monad testnet.
//
//   signer     Creates the simulation broadcast key under the gitignored secrets tree if absent
//              (mode 0600) and prints its address and MON balance. Never prints the key.
//   fund       Sends MON to that key from the deployer's encrypted keystore. Amount in MON,
//              default 0.5; refuses more than 2 so a typo cannot drain the deployer.
//   simulate   Compiles the workflow and runs one cron execution with `--broadcast`, so the report
//              is delivered on chain through the Monad testnet simulation forwarder.
//
// `cre workflow simulate` signs the forwarder transaction with CRE_ETH_PRIVATE_KEY. The key is handed
// to the CLI only through the child process environment, never written to an .env file, and the RPC
// URL is passed the same way so the provider key stays out of `project.yaml`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { foundry } from "./foundry-bin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const keyPath = join(root, "secrets/testnet/cre-simulation-signer");
const creBinary = process.env.CRE_BINARY ?? join(homedir(), ".cre/bin/cre");

process.loadEnvFile(process.env.OPENBALANCE_ENV_FILE ?? join(root, ".env.testnet"));
const rpcUrl = process.env.ACCOUNT_RPC_URL;
if (!rpcUrl?.startsWith("https://")) throw new Error("ACCOUNT_RPC_URL must be an https URL");

const redact = (text) => text.split(rpcUrl).join("<rpc>");
const cast = (args) => foundry("cast", args, { cwd: root });

async function signerKey() {
  if (!existsSync(keyPath)) {
    const created = JSON.parse(await cast(["wallet", "new", "--json"]));
    const privateKey = (created.data ?? created)[0]?.private_key;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) throw new Error("cast wallet new failed");
    await mkdir(join(root, "secrets/testnet"), { recursive: true });
    await writeFile(keyPath, `${privateKey}\n`, { mode: 0o600 });
  }
  await chmod(keyPath, 0o600);
  return (await readFile(keyPath, "utf8")).trim();
}

async function signerAddress() {
  return (await cast(["wallet", "address", "--private-key", await signerKey()])).trim();
}

async function signer() {
  const address = await signerAddress();
  const balance = BigInt(await cast(["balance", address, "--rpc-url", rpcUrl]));
  process.stdout.write(
    `${JSON.stringify({ address, balanceMon: `${Number(balance) / 1e18}` }, null, 2)}\n`,
  );
}

async function fund(amount = "0.5") {
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 2)
    throw new Error("Amount must be a MON value greater than 0 and at most 2");
  for (const name of ["DEPLOYER_KEYSTORE_PATH", "DEPLOYER_KEYSTORE_PASSWORD_FILE"])
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  const address = await signerAddress();
  const receipt = JSON.parse(
    await cast([
      "send",
      "--rpc-url",
      rpcUrl,
      "--keystore",
      join(root, process.env.DEPLOYER_KEYSTORE_PATH),
      "--password-file",
      join(root, process.env.DEPLOYER_KEYSTORE_PASSWORD_FILE),
      "--value",
      `${amount}ether`,
      "--json",
      address,
    ]),
  );
  if (receipt.status !== "0x1") throw new Error("Funding transaction did not succeed");
  process.stdout.write(
    `${JSON.stringify({ funded: address, amountMon: amount, transactionHash: receipt.transactionHash }, null, 2)}\n`,
  );
}

async function simulate() {
  if (!existsSync(creBinary)) throw new Error(`CRE CLI not found at ${creBinary}`);
  const env = {
    ...process.env,
    CRE_ETH_PRIVATE_KEY: await signerKey(),
    CRE_MONAD_TESTNET_RPC_URL: rpcUrl,
    PATH: `${join(homedir(), ".bun/bin")}:${process.env.PATH}`,
  };
  const child = spawn(
    creBinary,
    [
      "workflow",
      "simulate",
      "reserve-return",
      "--target",
      "staging-settings",
      "--non-interactive",
      "--trigger-index",
      "0",
      "--broadcast",
    ],
    { cwd: join(root, "cre"), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => process.stdout.write(redact(chunk.toString())));
  child.stderr.on("data", (chunk) => process.stderr.write(redact(chunk.toString())));
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) process.exitCode = code ?? 1;
}

const commands = { signer, fund, simulate };
const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
  process.stderr.write(`Usage: cre-reserve-return.mjs ${Object.keys(commands).join(" | ")}\n`);
  process.exitCode = 64;
} else {
  await commands[command](...rest).catch((error) => {
    process.stderr.write(`${redact(error.message)}\n`);
    process.exitCode = 1;
  });
}
