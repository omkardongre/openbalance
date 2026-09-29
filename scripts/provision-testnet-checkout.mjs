// Builds the deployed checkout manifest for the testnet event and the capability key the API signs
// order capabilities with. Without both, `services/api/src/server.ts` never constructs
// CheckoutService, so every checkout route is absent and an authenticated VENDOR credential resolves
// no checkout policy — the cashier terminal reports the credential as unauthorized.
//
// Every value in the emitted manifest is read back from the chain rather than copied from the local
// provisioning record. The manifest is what the API trusts when it accepts an order, so a value that
// was only ever asserted locally would let a stale file widen policy. The local records supply
// identifiers to look up; the chain supplies the facts.
//
// The capability key is a MAC key, not an identity: rotating it invalidates outstanding order
// capabilities and nothing else. It is created once and reused, so a re-run does not silently
// invalidate orders that are mid-flight.
//
// Idempotent. Re-running with the same chain state rewrites identical bytes.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { foundry } from "./foundry-bin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outDir = fileURLToPath(new URL("../deployments/testnet/", import.meta.url));
const secretsDir = fileURLToPath(new URL("../secrets/testnet/", import.meta.url));

const CHAIN_ID = 10_143n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const VENDOR_NAME = "North Gate Coffee";
// A payment intent must be presentable, signed and submitted inside this window. Short enough that a
// captured intent stops being replayable quickly, long enough for an attendee to finish a tap.
const INTENT_LIFETIME_SECONDS = 600;
// Ceilings the API enforces before it will write a reserve order. They cannot exceed what the event
// config allows on chain, which is asserted below; these are the tighter operational limits.
const RESERVE_POLICY = {
  maximumReserveUnits: 50_000_000n,
  maximumPerVoucherUnits: 15_000_000n,
  maximumVoucherCount: 8,
};
// Reserve windows the terminal offers. The event config only bounds them from above, so a demo event
// can return unspent reserves within minutes instead of hours while the on-chain ceilings stay put.
// Unset means the ceiling itself. Each must be at least a minute so a terminal can still operate.
// Read from CHECKOUT_RESERVE_ACCEPTANCE_SECONDS and CHECKOUT_RESERVE_SUBMISSION_SECONDS.
const CAPABILITY_KEY_BYTES = 32;

/** Resolves an operational window, refusing anything outside [60, on-chain ceiling]. */
function reserveWindow(name, ceiling) {
  const override = process.env[name];
  if (override === undefined || override === "") return ceiling;
  if (!/^[1-9][0-9]*$/.test(override)) throw new Error(`${name} must be a positive integer`);
  const seconds = Number(override);
  if (seconds < 60 || seconds > ceiling)
    throw new Error(`${name} must be between 60 and the event config ceiling of ${ceiling}`);
  return seconds;
}

const cast = (args) => foundry("cast", args, { cwd: root });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function rpcUrl() {
  const url = requireEnv("ACCOUNT_RPC_URL");
  if (new URL(url).protocol !== "https:") throw new Error("ACCOUNT_RPC_URL must use HTTPS");
  return url;
}

async function codeHashAt(url, address) {
  const code = await cast(["code", "--rpc-url", url, address]);
  if (!code || code === "0x") throw new Error(`No bytecode at ${address}`);
  return await cast(["keccak", code]);
}

/** Confirms every manifest address still runs the bytecode the verifier manifest bound it to. */
async function assertBoundBytecode(url, manifest) {
  for (const name of ["registry", "ledger", "router", "vault"]) {
    const record = manifest[name];
    if (!ADDRESS.test(record?.address ?? "") || !BYTES32.test(record?.runtimeCodeHash ?? ""))
      throw new Error(`Verifier manifest has no ${name} binding`);
    const observed = await codeHashAt(url, record.address);
    if (observed !== record.runtimeCodeHash)
      throw new Error(`${name} bytecode at ${record.address} does not match the manifest`);
  }
}

function fields(output) {
  return output.split("\n").map((line) => line.trim());
}

async function main() {
  const url = rpcUrl();
  const chainId = BigInt(await cast(["chain-id", "--rpc-url", url]));
  if (chainId !== CHAIN_ID) throw new Error(`Expected Monad testnet ${CHAIN_ID}, got ${chainId}`);

  const verifier = JSON.parse(await readFile(`${outDir}verifier-manifest.json`, "utf8"));
  const provisioning = JSON.parse(await readFile(`${outDir}event-provisioning.json`, "utf8"));
  await assertBoundBytecode(url, verifier);

  const registry = verifier.registry.address;
  const eventId = String(verifier.eventId).toLowerCase();
  if (!BYTES32.test(eventId)) throw new Error("Verifier manifest has no event identifier");
  if (eventId !== String(provisioning.eventId).toLowerCase())
    throw new Error("Verifier and provisioning records disagree on the event identifier");

  const streamId = `testnet:${CHAIN_ID}:${eventId}`;
  const vendorId = String(provisioning.vendorId).toLowerCase();
  const terminalId = String(provisioning.terminalId).toLowerCase();
  if (!BYTES32.test(vendorId) || !BYTES32.test(terminalId))
    throw new Error("Provisioning record has no vendor or terminal identifier");

  const configVersion = BigInt(provisioning.configVersion);
  const destinationVersion = BigInt(provisioning.destinationVersion);
  const terminalVersion = BigInt(provisioning.terminalVersion);

  // The event config carries the fee split and the reserve-window ceilings the manifest must respect.
  const config = fields(
    await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "configs(uint256)(uint48,uint48,uint16,uint16,uint48,uint48,address,address,bytes32,bool)",
      String(configVersion),
    ]),
  );
  if (config[9] !== "true")
    throw new Error(`Event config ${configVersion} is not registered and enabled`);
  const organizerFeeBps = Number(config[2]);
  const platformFeeBps = Number(config[3]);
  const acceptanceCeiling = Number(config[4]);
  const submissionCeiling = Number(config[5]);
  if (!Number.isSafeInteger(organizerFeeBps) || !Number.isSafeInteger(platformFeeBps))
    throw new Error("Event config returned an unreadable fee split");
  if (acceptanceCeiling < 60 || submissionCeiling < 60)
    throw new Error("Event config reserve windows are too short to operate a terminal");
  const acceptanceDurationSeconds = reserveWindow(
    "CHECKOUT_RESERVE_ACCEPTANCE_SECONDS",
    acceptanceCeiling,
  );
  const submissionDelaySeconds = reserveWindow(
    "CHECKOUT_RESERVE_SUBMISSION_SECONDS",
    submissionCeiling,
  );

  const vendor = fields(
    await cast(["call", "--rpc-url", url, registry, "vendors(bytes32)(address,bool)", vendorId]),
  );
  if (vendor[0]?.toLowerCase() === ZERO_ADDRESS || vendor[1] !== "true")
    throw new Error(`Vendor ${vendorId} is not registered and enabled`);

  const destination = fields(
    await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "destinations(bytes32,uint256)(address,bool)",
      vendorId,
      String(destinationVersion),
    ]),
  );
  if (destination[0]?.toLowerCase() === ZERO_ADDRESS || destination[1] !== "true")
    throw new Error(`Vendor payout destination ${destinationVersion} is not approved and enabled`);

  // The terminal record is the authority for which key may sign an intent, and which vendor it signs
  // for. Both are asserted here so the manifest cannot bind a terminal to the wrong vendor.
  const terminal = fields(
    await cast([
      "call",
      "--rpc-url",
      url,
      registry,
      "terminals(bytes32,uint256)(bytes32,address,uint48,uint48,bool)",
      terminalId,
      String(terminalVersion),
    ]),
  );
  if (terminal[4] !== "true")
    throw new Error(`Terminal ${terminalId} version ${terminalVersion} is not enabled`);
  if (terminal[0]?.toLowerCase() !== vendorId)
    throw new Error(`Terminal ${terminalId} is bound to a different vendor than ${vendorId}`);
  const terminalSigner = terminal[1];
  if (!ADDRESS.test(terminalSigner ?? "")) throw new Error("Terminal record has no signer");
  if (terminalSigner.toLowerCase() !== String(provisioning.terminalSigner).toLowerCase())
    throw new Error("Chain and provisioning records disagree on the terminal signer");

  // Asset metadata comes from the token contract so the terminal renders the same unit the ledger
  // accounts in. A wrong decimals value here would misprice every displayed amount.
  const asset = verifier.asset;
  if (!ADDRESS.test(asset ?? "")) throw new Error("Verifier manifest has no asset address");
  const assetSymbol = (await cast(["call", "--rpc-url", url, asset, "symbol()(string)"]))
    .trim()
    .replace(/^"|"$/g, "");
  const assetDecimals = Number(await cast(["call", "--rpc-url", url, asset, "decimals()(uint8)"]));
  if (!/^[A-Z0-9]{2,12}$/.test(assetSymbol))
    throw new Error(`Unusable asset symbol ${assetSymbol}`);
  if (!Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 36)
    throw new Error(`Unusable asset decimals ${assetDecimals}`);

  if (RESERVE_POLICY.maximumPerVoucherUnits > RESERVE_POLICY.maximumReserveUnits)
    throw new Error("Per-voucher ceiling exceeds the reserve ceiling");

  const manifest = {
    schemaVersion: 1,
    chainId: Number(CHAIN_ID),
    events: [
      {
        streamId,
        eventId,
        router: verifier.router.address,
        registry,
        ledger: verifier.ledger.address,
        vault: verifier.vault.address,
        runtimeCodeHashes: {
          registry: verifier.registry.runtimeCodeHash,
          ledger: verifier.ledger.runtimeCodeHash,
          router: verifier.router.runtimeCodeHash,
          vault: verifier.vault.runtimeCodeHash,
        },
        asset,
        assetSymbol,
        assetDecimals,
        configVersion: configVersion.toString(),
        organizerFeeBps,
        platformFeeBps,
        intentLifetimeSeconds: INTENT_LIFETIME_SECONDS,
        vendors: [
          {
            vendorId,
            vendorName: VENDOR_NAME,
            destinationVersion: destinationVersion.toString(),
            terminal: {
              instanceId: terminalId,
              keyVersion: terminalVersion.toString(),
              signer: terminalSigner,
            },
            reservePolicy: {
              maximumReserveUnits: RESERVE_POLICY.maximumReserveUnits.toString(),
              maximumPerVoucherUnits: RESERVE_POLICY.maximumPerVoucherUnits.toString(),
              maximumVoucherCount: RESERVE_POLICY.maximumVoucherCount,
              acceptanceDurationSeconds,
              submissionDelaySeconds,
            },
          },
        ],
      },
    ],
  };

  const manifestPath = `${outDir}checkout-manifest.json`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // Raw bytes, no encoding and no trailing newline: the API reads the file as the key material
  // itself and rejects anything outside 32 to 64 bytes.
  await mkdir(secretsDir, { recursive: true });
  const capabilityPath = `${secretsDir}checkout-capability`;
  let capabilityCreated = false;
  try {
    const existing = await readFile(capabilityPath);
    if (existing.length < 32 || existing.length > 64)
      throw new Error(`${capabilityPath} must hold 32 to 64 raw bytes, found ${existing.length}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(capabilityPath, randomBytes(CAPABILITY_KEY_BYTES));
    await chmod(capabilityPath, 0o600);
    capabilityCreated = true;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        manifest: manifestPath,
        capabilityKey: capabilityPath,
        capabilityKeyCreated: capabilityCreated,
        streamId,
        eventId,
        vendorId,
        terminalId,
        terminalSigner,
        assetSymbol,
        assetDecimals,
        organizerFeeBps,
        platformFeeBps,
        acceptanceDurationSeconds,
        submissionDelaySeconds,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Provisioning failed"}\n`);
  process.exitCode = 1;
});
