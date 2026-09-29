// Registers a second vendor whose terminal key is held by a physical Android terminal.
//
// The Android terminal generates its own secp256k1 key on the device and never exports it, so its
// address has to be registered on chain rather than a locally generated key being loaded into it.
// A separate vendor keeps the existing vendor and its terminal untouched: the checkout manifest binds
// exactly one terminal per vendor, and the web cashier signs with the existing terminal key.
//
// The device key reports key version 1 in every upload authorization, so the terminal is registered
// under a fresh terminal id at version 1 instead of as version 2 of the existing terminal.
//
// Idempotent in the same way as provision-testnet-event.mjs: every slot is read before it is
// written, and a slot that already holds a different value fails rather than being overwritten.
//
// Usage: DEVICE_TERMINAL_SIGNER=0x... node --env-file=.env.testnet scripts/provision-device-terminal.mjs

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { foundry } from "./foundry-bin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = fileURLToPath(new URL("../deployments/testnet/", import.meta.url));
const secretsDir = fileURLToPath(new URL("../secrets/testnet/", import.meta.url));

const CHAIN_ID = 10_143n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DESTINATION_VERSION = 1n;
const TERMINAL_VERSION = 1n;
const VENDOR_LABEL = "openbalance:testnet:vendor:2";
const TERMINAL_LABEL = "openbalance:testnet:terminal:2";
const TERMINAL_VALIDITY_SECONDS = 30 * 24 * 3_600;

const cast = (args) => foundry("cast", args, { cwd: root });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const fromRoot = (path) => (isAbsolute(path) ? path : resolve(root, path));

function rpcUrl() {
  const url = requireEnv("ACCOUNT_RPC_URL");
  if (new URL(url).protocol !== "https:") throw new Error("ACCOUNT_RPC_URL must use HTTPS");
  return url;
}

function signer() {
  return [
    "--keystore",
    fromRoot(requireEnv("DEPLOYER_KEYSTORE_PATH")),
    "--password-file",
    fromRoot(requireEnv("DEPLOYER_KEYSTORE_PASSWORD_FILE")),
  ];
}

/** Sends one organizer transaction with gas price, gas limit and nonce pinned (see provision-testnet-event.mjs). */
async function sendPinned(url, nonce, gasPrice, gasLimit, args) {
  const output = await cast([
    "send",
    "--rpc-url",
    url,
    ...signer(),
    "--gas-limit",
    String(gasLimit),
    "--gas-price",
    String(gasPrice),
    "--nonce",
    String(nonce),
    "--json",
    ...args,
  ]);
  const receipt = JSON.parse(output.slice(output.indexOf("{")));
  if (receipt.status !== "0x1")
    throw new Error(`Transaction reverted: ${receipt.transactionHash ?? "(no hash)"}`);
  return receipt.transactionHash;
}

const lines = (output) => output.split("\n").map((line) => line.trim());

async function main() {
  const deviceSigner = requireEnv("DEVICE_TERMINAL_SIGNER");
  if (!ADDRESS.test(deviceSigner) || deviceSigner.toLowerCase() === ZERO_ADDRESS)
    throw new Error("DEVICE_TERMINAL_SIGNER must be a non-zero address");

  const url = rpcUrl();
  const chainId = BigInt(await cast(["chain-id", "--rpc-url", url]));
  if (chainId !== CHAIN_ID) throw new Error(`Expected Monad testnet ${CHAIN_ID}, got ${chainId}`);

  const manifest = JSON.parse(await readFile(`${outDir}verifier-manifest.json`, "utf8"));
  const primary = JSON.parse(await readFile(`${outDir}event-provisioning.json`, "utf8"));
  const registry = manifest.registry?.address;
  if (!ADDRESS.test(registry ?? "")) throw new Error("Verifier manifest has no registry address");
  const code = await cast(["code", "--rpc-url", url, registry]);
  if ((await cast(["keccak", code])) !== manifest.registry.runtimeCodeHash)
    throw new Error(`Registry bytecode at ${registry} does not match the manifest`);

  const organizer = await cast(["wallet", "address", ...signer()]);
  const onChainOrganizer = await cast(["call", "--rpc-url", url, registry, "organizer()(address)"]);
  if (onChainOrganizer.toLowerCase() !== organizer.toLowerCase())
    throw new Error(`Keystore address ${organizer} is not this event's organizer`);

  // The existing vendor authority key also approves this vendor's payout destination, so vendor 2
  // pays out to the same treasury the operator already controls.
  const vendorKey = (await readFile(`${secretsDir}vendor-authority`, "utf8")).trim();
  if (!BYTES32.test(vendorKey)) throw new Error("secrets/testnet/vendor-authority is not a key");
  const vendorAuthority = await cast(["wallet", "address", vendorKey]);

  const vendorId = await cast(["keccak", VENDOR_LABEL]);
  const terminalId = await cast(["keccak", TERMINAL_LABEL]);

  const now = Number(await cast(["block", "--rpc-url", url, "latest", "--field", "timestamp"]));
  let nonce = Number(await cast(["nonce", organizer, "--rpc-url", url]));
  const gasPrice = (BigInt(await cast(["gas-price", "--rpc-url", url])) * 12n) / 10n;
  const written = [];

  const readVendor = async () =>
    lines(
      await cast(["call", "--rpc-url", url, registry, "vendors(bytes32)(address,bool)", vendorId]),
    );
  const readDestination = async () =>
    lines(
      await cast([
        "call",
        "--rpc-url",
        url,
        registry,
        "destinations(bytes32,uint256)(address,bool)",
        vendorId,
        String(DESTINATION_VERSION),
      ]),
    );
  const readTerminal = async () =>
    lines(
      await cast([
        "call",
        "--rpc-url",
        url,
        registry,
        "terminals(bytes32,uint256)(bytes32,address,uint48,uint48,bool)",
        terminalId,
        String(TERMINAL_VERSION),
      ]),
    );

  if ((await readVendor())[0].toLowerCase() === ZERO_ADDRESS) {
    written.push({
      step: "registerVendor",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 200_000, [
        registry,
        "registerVendor(bytes32,address)",
        vendorId,
        vendorAuthority,
      ]),
    });
  }

  if ((await readDestination())[0].toLowerCase() === ZERO_ADDRESS) {
    const deadline = BigInt(now + 3_600);
    const digest = (
      await cast([
        "call",
        "--rpc-url",
        url,
        registry,
        "destinationDigest(bytes32,uint256,address,uint256)(bytes32)",
        vendorId,
        String(DESTINATION_VERSION),
        vendorAuthority,
        String(deadline),
      ])
    ).trim();
    if (!BYTES32.test(digest)) throw new Error("Destination digest read failed");
    // The registry recovers from the raw digest, so no personal-message prefix.
    const signature = (
      await cast(["wallet", "sign", "--no-hash", "--private-key", vendorKey, digest])
    ).trim();
    written.push({
      step: "registerDestination",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 250_000, [
        registry,
        "registerDestination(bytes32,uint256,address,uint256,bytes)",
        vendorId,
        String(DESTINATION_VERSION),
        vendorAuthority,
        String(deadline),
        signature,
      ]),
    });
  }

  const existingTerminal = await readTerminal();
  if (existingTerminal[1].toLowerCase() === ZERO_ADDRESS) {
    written.push({
      step: "registerTerminal",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 250_000, [
        registry,
        "registerTerminal(bytes32,uint256,bytes32,address,uint48,uint48)",
        terminalId,
        String(TERMINAL_VERSION),
        vendorId,
        deviceSigner,
        String(now - 60),
        String(now + TERMINAL_VALIDITY_SECONDS),
      ]),
    });
  } else if (existingTerminal[1].toLowerCase() !== deviceSigner.toLowerCase()) {
    // A registered slot is permanent. A different device needs a new terminal label, not a rewrite.
    throw new Error(`Terminal 2 is already bound to ${existingTerminal[1]}, not ${deviceSigner}`);
  }

  // Read back rather than assume the writes landed.
  const vendor = await readVendor();
  const destination = await readDestination();
  const terminal = await readTerminal();
  if (vendor[0].toLowerCase() !== vendorAuthority.toLowerCase() || vendor[1] !== "true")
    throw new Error("Vendor 2 is not registered to the vendor authority and enabled");
  if (destination[1] !== "true") throw new Error("Vendor 2 destination is not enabled");
  if (
    terminal[0].toLowerCase() !== vendorId.toLowerCase() ||
    terminal[1].toLowerCase() !== deviceSigner.toLowerCase() ||
    terminal[4] !== "true"
  )
    throw new Error("Terminal 2 is not bound to vendor 2 and the device signer");

  const record = {
    schemaVersion: 1,
    chainId: Number(CHAIN_ID),
    eventId: primary.eventId,
    registry,
    vendorName: "OpenBalance Android Terminal",
    vendorId,
    vendorAuthority,
    destinationVersion: Number(DESTINATION_VERSION),
    destination: destination[0],
    terminalId,
    terminalVersion: Number(TERMINAL_VERSION),
    terminalSigner: terminal[1],
  };
  await writeFile(
    `${outDir}device-terminal-provisioning.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ passed: true, written, ...record }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ passed: false, error: error.message })}\n`);
  process.exitCode = 1;
});
