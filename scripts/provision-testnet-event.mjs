// Registers the organizer-owned policy an event needs before any money can move: a fee/timing
// config version, a vendor and its authority, that vendor's approved payout destination, and a
// terminal key. These are `onlyOrganizer` calls on the deployed EventRegistry, so they are signed by
// the organizer's encrypted keystore and never by a key held in the environment.
//
// Idempotent by reading each record before writing it. The registry rejects a second write to any of
// these slots with AlreadyExists, so a re-run must skip rather than retry: registering a *new*
// version instead would silently diverge from the version the services were told to use.
//
// The vendor authority and terminal signer are operational signing keys that later steps must sign
// with directly, so they are written as raw key files under the gitignored secrets/ tree at mode
// 0600. The organizer key is not one of them and stays encrypted.
//
// Shells out to verified Foundry binaries rather than importing a chain client, matching the other
// root-level scripts.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

// One vendor and one terminal are enough to prove every money rule; more would add setup without
// adding a distinct claim. Configs are first-write-only, so a new policy is a new version: v1
// (Sep 2026) capped spending at 1 h and expires 23 Oct 2026; v2 (11 Oct 2026) allows the 2 h demo
// spend window and stays valid through judging and the winner announcement.
const CONFIG_VERSION = 2n;
const DESTINATION_VERSION = 1n;
const TERMINAL_VERSION = 1n;
const VENDOR_LABEL = "openbalance:testnet:vendor:1";
const TERMINAL_LABEL = "openbalance:testnet:terminal:1";
const TERMS_LABEL = "openbalance:testnet:terms:1";
const ORGANIZER_FEE_BPS = 200;
const PLATFORM_FEE_BPS = 100;
// Bounds on what a reserve channel may later ask for. They cap the channel's own windows, so they
// must be at least as long as the shortest windows a real-time test can use and no longer than the
// operator would accept being committed to.
const MAXIMUM_ACCEPTANCE_DURATION = 7_200;
const MAXIMUM_SUBMISSION_DELAY = 3_600;
const CONFIG_VALIDITY_SECONDS = 60 * 24 * 3_600;

const cast = (args) => foundry("cast", args, { cwd: root });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function fromRoot(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

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

/**
 * Sends one organizer transaction with gas price, gas limit and nonce all pinned.
 *
 * The configured provider intermittently answers the estimation and receipt-index reads inside a
 * bare `cast send` with an internal archive error while still broadcasting the transaction, which is
 * indistinguishable from a failure at the call site and invites a retry that sends it twice. Pinning
 * every value avoids those reads entirely, so a failure here is a real failure.
 */
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

async function codeHashAt(url, address) {
  const code = await cast(["code", "--rpc-url", url, address]);
  if (!code || code === "0x") throw new Error(`No bytecode at ${address}`);
  return await cast(["keccak", code]);
}

async function main() {
  const url = rpcUrl();
  const chainId = BigInt(await cast(["chain-id", "--rpc-url", url]));
  if (chainId !== CHAIN_ID) throw new Error(`Expected Monad testnet ${CHAIN_ID}, got ${chainId}`);

  const manifestPath = `${outDir}verifier-manifest.json`;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const registry = manifest.registry?.address;
  if (!ADDRESS.test(registry ?? "")) throw new Error("Verifier manifest has no registry address");

  // The manifest binds the address to the bytecode that ran there. Provisioning writes authority, so
  // it verifies that binding still holds rather than trusting the address alone.
  const observedCodeHash = await codeHashAt(url, registry);
  if (observedCodeHash !== manifest.registry.runtimeCodeHash)
    throw new Error(
      `Registry bytecode at ${registry} does not match the manifest: ${observedCodeHash}`,
    );

  const organizer = await cast(["wallet", "address", ...signer()]);
  const onChainOrganizer = await cast(["call", "--rpc-url", url, registry, "organizer()(address)"]);
  if (onChainOrganizer.toLowerCase() !== organizer.toLowerCase())
    throw new Error(
      `Keystore address ${organizer} is not this event's organizer (${onChainOrganizer})`,
    );

  const maximumFeeBps = Number(
    await cast(["call", "--rpc-url", url, registry, "maximumFeeBps()(uint16)"]),
  );
  if (ORGANIZER_FEE_BPS + PLATFORM_FEE_BPS > maximumFeeBps)
    throw new Error(`Fees exceed the event's immutable maximum of ${maximumFeeBps} bps`);

  const vendorId = await cast(["keccak", VENDOR_LABEL]);
  const terminalId = await cast(["keccak", TERMINAL_LABEL]);
  const termsHash = await cast(["keccak", TERMS_LABEL]);
  if (!BYTES32.test(vendorId) || !BYTES32.test(terminalId) || !BYTES32.test(termsHash))
    throw new Error("Identifier derivation failed");

  // Operational signing keys the later money steps must sign with. Created once and reused, because
  // the registry binds the registered address permanently to this vendor and terminal version.
  await mkdir(secretsDir, { recursive: true });
  const keyFor = async (name) => {
    const path = `${secretsDir}${name}`;
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(existing))
        throw new Error(`${path} does not contain a private key`);
      return { privateKey: existing, address: await cast(["wallet", "address", existing]) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const created = JSON.parse(await cast(["wallet", "new", "--json"]));
      const entry = Array.isArray(created) ? created[0] : created.data?.[0];
      if (!entry?.private_key || !ADDRESS.test(entry.address ?? ""))
        throw new Error("Key generation did not return a usable key");
      await writeFile(path, `${entry.private_key}\n`, "utf8");
      await chmod(path, 0o600);
      return { privateKey: entry.private_key, address: entry.address };
    }
  };
  const vendorAuthority = await keyFor("vendor-authority");
  const terminalSigner = await keyFor("terminal-signer");

  const now = Number(await cast(["block", "--rpc-url", url, "latest", "--field", "timestamp"]));
  const nonceStart = Number(await cast(["nonce", organizer, "--rpc-url", url]));
  const gasPrice = (BigInt(await cast(["gas-price", "--rpc-url", url])) * 12n) / 10n;
  let nonce = nonceStart;
  const written = [];

  const config = await cast([
    "call",
    "--rpc-url",
    url,
    registry,
    "configs(uint256)(uint48,uint48,uint16,uint16,uint48,uint48,address,address,bytes32,bool)",
    String(CONFIG_VERSION),
  ]);
  // validUntil is the registry's own emptiness test for a config slot, so it is the field to read.
  const configValidUntil = config.split("\n")[1]?.trim();
  if (configValidUntil === "0") {
    const validAfter = now - 60;
    const validUntil = now + CONFIG_VALIDITY_SECONDS;
    const tuple = `(${validAfter},${validUntil},${ORGANIZER_FEE_BPS},${PLATFORM_FEE_BPS},${MAXIMUM_ACCEPTANCE_DURATION},${MAXIMUM_SUBMISSION_DELAY},${organizer},${organizer},${termsHash},true)`;
    written.push({
      step: "registerConfig",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 300_000, [
        registry,
        "registerConfig(uint256,(uint48,uint48,uint16,uint16,uint48,uint48,address,address,bytes32,bool))",
        String(CONFIG_VERSION),
        tuple,
      ]),
    });
  }

  const vendor = await cast([
    "call",
    "--rpc-url",
    url,
    registry,
    "vendors(bytes32)(address,bool)",
    vendorId,
  ]);
  if (vendor.split("\n")[0]?.trim().toLowerCase() === ZERO_ADDRESS) {
    written.push({
      step: "registerVendor",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 200_000, [
        registry,
        "registerVendor(bytes32,address)",
        vendorId,
        vendorAuthority.address,
      ]),
    });
  }

  const destination = await cast([
    "call",
    "--rpc-url",
    url,
    registry,
    "destinations(bytes32,uint256)(address,bool)",
    vendorId,
    String(DESTINATION_VERSION),
  ]);
  if (destination.split("\n")[0]?.trim().toLowerCase() === ZERO_ADDRESS) {
    // The payout destination is approved by the vendor, not by the organizer, so the organizer can
    // register it but cannot choose it. The deadline bounds that approval.
    const deadline = BigInt(now + 3_600);
    const digest = await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "destinationDigest(bytes32,uint256,address,uint256)(bytes32)",
      vendorId,
      String(DESTINATION_VERSION),
      vendorAuthority.address,
      String(deadline),
    ]);
    if (!BYTES32.test(digest.trim())) throw new Error("Destination digest read failed");
    // The registry recovers from the raw digest, so this must be signed without the personal-message
    // prefix a default signing call would add.
    const signature = await cast([
      "wallet",
      "sign",
      "--no-hash",
      "--private-key",
      vendorAuthority.privateKey,
      digest.trim(),
    ]);
    written.push({
      step: "registerDestination",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 250_000, [
        registry,
        "registerDestination(bytes32,uint256,address,uint256,bytes)",
        vendorId,
        String(DESTINATION_VERSION),
        vendorAuthority.address,
        String(deadline),
        signature.trim(),
      ]),
    });
  }

  const terminal = await cast([
    "call",
    "--rpc-url",
    url,
    registry,
    "terminals(bytes32,uint256)(bytes32,address,uint48,uint48,bool)",
    terminalId,
    String(TERMINAL_VERSION),
  ]);
  if (terminal.split("\n")[1]?.trim().toLowerCase() === ZERO_ADDRESS) {
    written.push({
      step: "registerTerminal",
      transactionHash: await sendPinned(url, nonce++, gasPrice, 250_000, [
        registry,
        "registerTerminal(bytes32,uint256,bytes32,address,uint48,uint48)",
        terminalId,
        String(TERMINAL_VERSION),
        vendorId,
        terminalSigner.address,
        String(now - 60),
        String(now + CONFIG_VALIDITY_SECONDS),
      ]),
    });
  }

  // Read every record back after writing. A provisioning run that reported success without
  // confirming the registry's own view would be asserting intent rather than state.
  const readBack = {
    config: await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "configs(uint256)(uint48,uint48,uint16,uint16,uint48,uint48,address,address,bytes32,bool)",
      String(CONFIG_VERSION),
    ]),
    vendor: await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "vendors(bytes32)(address,bool)",
      vendorId,
    ]),
    destination: await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "destinations(bytes32,uint256)(address,bool)",
      vendorId,
      String(DESTINATION_VERSION),
    ]),
    terminal: await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "terminals(bytes32,uint256)(bytes32,address,uint48,uint48,bool)",
      terminalId,
      String(TERMINAL_VERSION),
    ]),
  };
  const enabled = (value, index) => value.split("\n")[index]?.trim() === "true";
  if (!enabled(readBack.config, 9)) throw new Error("Config is not registered and enabled");
  if (!enabled(readBack.vendor, 1)) throw new Error("Vendor is not registered and enabled");
  if (!enabled(readBack.destination, 1))
    throw new Error("Destination is not registered and enabled");
  if (!enabled(readBack.terminal, 4)) throw new Error("Terminal is not registered and enabled");
  if (
    readBack.vendor.split("\n")[0]?.trim().toLowerCase() !== vendorAuthority.address.toLowerCase()
  )
    throw new Error("Registered vendor authority does not match the local key");
  if (
    readBack.terminal.split("\n")[1]?.trim().toLowerCase() !== terminalSigner.address.toLowerCase()
  )
    throw new Error("Registered terminal signer does not match the local key");

  // Public identifiers only. The vendor and terminal private keys stay in the gitignored secrets tree.
  const record = {
    schemaVersion: 1,
    chainId: Number(CHAIN_ID),
    eventId: manifest.eventId,
    registry,
    organizer,
    configVersion: Number(CONFIG_VERSION),
    organizerFeeBps: ORGANIZER_FEE_BPS,
    platformFeeBps: PLATFORM_FEE_BPS,
    maximumAcceptanceDuration: MAXIMUM_ACCEPTANCE_DURATION,
    maximumSubmissionDelay: MAXIMUM_SUBMISSION_DELAY,
    vendorId,
    vendorAuthority: vendorAuthority.address,
    destinationVersion: Number(DESTINATION_VERSION),
    destination: vendorAuthority.address,
    terminalId,
    terminalVersion: Number(TERMINAL_VERSION),
    terminalSigner: terminalSigner.address,
  };
  await writeFile(`${outDir}event-provisioning.json`, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: true, alreadyProvisioned: written.length === 0, written, ...record }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ passed: false, error: error.message })}\n`);
  process.exitCode = 1;
});
