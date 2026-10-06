// Deploys the OpenBalance contracts to Monad testnet and publishes bytecode-bound manifests.
//
// Three separate commands, because deployment and attestation must not be one atomic-looking step:
//
//   preflight  Read-only. Proves the chain, signer funding, and settlement asset are what we expect.
//   deploy     Writes to chain. Resumable, and never redeploys something already recorded.
//   manifest   Read-only. Emits the manifests from code read at the finalized block.
//
// Splitting deploy from manifest is deliberate. A manifest binds an address to the hash of the
// bytecode actually running at it, read at the finalized tag, so it cannot be written truthfully
// until the deploying block is finalized. If a manifest read fails, the fix is to re-run `manifest`,
// never to redeploy: redeploying would orphan live contracts and burn the recorded addresses.
//
// Signing uses an encrypted keystore plus a password file rather than a raw private key, which is
// what Foundry and the Monad deployment guide both recommend, and keeps no plaintext key on disk.
//
// Shells out to verified Foundry binaries instead of importing viem, matching the other root-level
// scripts: this package has no workspace dependency on a chain client.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { foundry } from "./foundry-bin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const contractsDir = fileURLToPath(new URL("../contracts/", import.meta.url));
const outDir = fileURLToPath(new URL("../deployments/testnet/", import.meta.url));
const statePath = `${outDir}deployment-state.json`;

const CHAIN_ID = 10_143;

// Circle's published testnet USDC for Monad. Monad testnet was reset from genesis, so an asset
// address is only trustworthy when re-resolved from the issuer's own registry and then confirmed
// on chain below (code present, 6 decimals, USDC symbol) — never taken from a tutorial or cache.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

// Chainlink CRE forwarders on Monad testnet. `simulation` delivers reports broadcast by
// `cre workflow simulate --broadcast`; `production` delivers reports from a DON-deployed workflow.
// A trigger binds one forwarder immutably, so each forwarder gets its own trigger deployment.
// https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts
const CRE_FORWARDERS = {
  simulation: "0xB9F79d863261869B234c481D1f9A7af84AeAd192",
  production: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function rpcUrl() {
  const url = requireEnv("ACCOUNT_RPC_URL");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("ACCOUNT_RPC_URL must use HTTPS");
  return url;
}

const cast = (args) => foundry("cast", args, { cwd: root });

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(state) {
  await mkdir(outDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function chainId(url) {
  const value = await cast(["chain-id", "--rpc-url", url]);
  if (BigInt(value) !== BigInt(CHAIN_ID))
    throw new Error(`Expected Monad testnet chain ${CHAIN_ID}, got ${value}`);
  return CHAIN_ID;
}

/** A path relative to the repo root, regardless of which directory the calling process spawned in. */
function fromRoot(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

/** Signer flags. Kept in one place so no command can accidentally sign with a bare private key. */
function signer() {
  return [
    "--keystore",
    fromRoot(requireEnv("DEPLOYER_KEYSTORE_PATH")),
    "--password-file",
    fromRoot(requireEnv("DEPLOYER_KEYSTORE_PASSWORD_FILE")),
  ];
}

async function deployerAddress() {
  const address = await cast(["wallet", "address", ...signer()]);
  if (!ADDRESS.test(address)) throw new Error("Could not derive deployer address from keystore");
  return address;
}

async function codeHashAt(url, address, blockNumber) {
  const code = await cast(["code", "--rpc-url", url, "--block", String(blockNumber), address]);
  if (!code || code === "0x")
    throw new Error(`No bytecode at ${address} at finalized block ${blockNumber}`);
  return await cast(["keccak", code]);
}

async function call(url, address, signature, args = [], blockNumber) {
  return cast([
    "call",
    "--rpc-url",
    url,
    ...(blockNumber === undefined ? [] : ["--block", String(blockNumber)]),
    address,
    signature,
    ...args,
  ]);
}

/** Confirms the settlement asset is a real 6-decimal USDC contract, not an arbitrary address. */
async function verifyAsset(url, asset) {
  const code = await cast(["code", "--rpc-url", url, asset]);
  if (!code || code === "0x") throw new Error(`Settlement asset ${asset} has no bytecode`);
  const [decimals, symbol] = await Promise.all([
    call(url, asset, "decimals()(uint8)"),
    call(url, asset, "symbol()(string)"),
  ]);
  if (decimals.trim() !== "6")
    throw new Error(`Settlement asset must have 6 decimals, got ${decimals}`);
  const cleaned = symbol.trim().replace(/^"|"$/g, "");
  if (cleaned !== "USDC") throw new Error(`Settlement asset symbol must be USDC, got ${cleaned}`);
  return { address: asset, decimals: 6, symbol: cleaned };
}

async function finalizedBlock(url) {
  // `cast block-number` takes the block as a positional argument; there is no --block flag here.
  const number = await cast(["block-number", "--rpc-url", url, "finalized"]);
  return BigInt(number);
}

/** Blocks until the deploying block is finalized, so manifests describe irreversible state. */
async function awaitFinality(url, blockNumber, timeoutMs = 180_000) {
  const target = BigInt(blockNumber);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const finalized = await finalizedBlock(url);
    if (finalized >= target) return finalized;
    if (Date.now() > deadline)
      throw new Error(
        `Block ${target} not finalized within ${timeoutMs}ms (finalized ${finalized})`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function forgeCreate(url, contract, constructorArgs = []) {
  const output = await foundry(
    "forge",
    [
      "create",
      "--rpc-url",
      url,
      ...signer(),
      "--broadcast",
      "--json",
      contract,
      ...(constructorArgs.length ? ["--constructor-args", ...constructorArgs] : []),
    ],
    { cwd: contractsDir },
  );
  const result = JSON.parse(output.slice(output.indexOf("{")));
  if (!ADDRESS.test(result.deployedTo ?? "") || !BYTES32.test(result.transactionHash ?? ""))
    throw new Error(`Deployment of ${contract} did not return canonical references`);
  return { address: result.deployedTo, transactionHash: result.transactionHash };
}

async function receiptBlock(url, hash) {
  const value = await cast(["receipt", "--rpc-url", url, hash, "blockNumber"]);
  return BigInt(value.trim());
}

// --- commands ---------------------------------------------------------------------------------

async function preflight() {
  const url = rpcUrl();
  await chainId(url);
  const asset = await verifyAsset(url, process.env.TESTNET_ASSET_ADDRESS ?? USDC);
  const deployer = await deployerAddress();
  const balance = BigInt(await cast(["balance", deployer, "--rpc-url", url]));
  // A full deployment is four contract creations plus a multi-contract factory call. 0.5 MON is a
  // deliberately conservative floor; the point is to fail before a half-finished deployment.
  const minimum = 500_000_000_000_000_000n;
  const funded = balance >= minimum;
  const report = {
    passed: funded,
    chainId: CHAIN_ID,
    asset,
    deployer,
    balanceWei: balance.toString(),
    balanceMon: `${Number(balance) / 1e18}`,
    finalizedBlock: (await finalizedBlock(url)).toString(),
    forge: (await foundry("forge", ["--version"])).split("\n")[0],
  };
  if (!funded)
    report.error = `Deployer ${deployer} holds ${Number(balance) / 1e18} MON; fund it with at least 0.5 MON from a Monad testnet faucet before deploying`;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!funded) process.exitCode = 1;
}

async function deploy() {
  const url = rpcUrl();
  await chainId(url);
  const state = await readState();
  const deployer = await deployerAddress();
  if (state.deployer && state.deployer !== deployer)
    throw new Error(`State was created by ${state.deployer}, refusing to extend it as ${deployer}`);

  const asset = await verifyAsset(url, state.asset ?? process.env.TESTNET_ASSET_ADDRESS ?? USDC);
  const label = process.env.TESTNET_EVENT_LABEL ?? "openbalance:testnet:event:1";
  const riskOperator = process.env.TESTNET_RISK_OPERATOR ?? deployer;
  if (!ADDRESS.test(riskOperator)) throw new Error("TESTNET_RISK_OPERATOR must be an address");
  const maximumFeeBps = process.env.TESTNET_MAXIMUM_FEE_BPS ?? "500";
  if (!/^\d+$/.test(maximumFeeBps) || Number(maximumFeeBps) > 10_000)
    throw new Error("TESTNET_MAXIMUM_FEE_BPS must be an integer between 0 and 10000");

  Object.assign(state, {
    chainId: CHAIN_ID,
    deployer,
    asset: asset.address,
    eventLabel: label,
    riskOperator,
    maximumFeeBps: Number(maximumFeeBps),
  });
  await writeState(state);

  await foundry("forge", ["build"], { cwd: contractsDir });

  if (!state.accountFactory) {
    state.accountFactory = await forgeCreate(url, "src/accounts/AccountFactory.sol:AccountFactory");
    await writeState(state);
  }
  if (!state.eventFactory) {
    state.eventFactory = await forgeCreate(url, "src/payments/EventFactory.sol:EventFactory");
    await writeState(state);
  }

  if (!state.event) {
    const eventId = await cast(["keccak", label]);
    if (!BYTES32.test(eventId)) throw new Error("Event ID derivation failed");
    // getDeployment is authoritative: if this label was already deployed by this signer, adopt it
    // rather than sending a transaction that the factory would revert with AlreadyExists.
    const existing = await call(
      url,
      state.eventFactory.address,
      "getDeployment(address,bytes32)((address,address,address,address))",
      [deployer, eventId],
    );
    const known = (existing.match(/0x[0-9a-fA-F]{40}/g) ?? []).filter(
      (value) => value !== "0x0000000000000000000000000000000000000000",
    );
    if (known.length === 4) {
      state.event = { eventId, adopted: true };
    } else {
      const sent = JSON.parse(
        await cast([
          "send",
          "--json",
          "--rpc-url",
          url,
          ...signer(),
          state.eventFactory.address,
          "deployEvent(bytes32,address,address,uint16)",
          eventId,
          asset.address,
          riskOperator,
          maximumFeeBps,
        ]),
      );
      if (sent.status !== "0x1") throw new Error("deployEvent reverted");
      state.event = {
        eventId,
        transactionHash: sent.transactionHash,
        blockNumber: BigInt(sent.blockNumber).toString(),
      };
    }
    await writeState(state);
  }

  process.stdout.write(
    `${JSON.stringify({ deployed: true, ...state, next: "Run `manifest` once these blocks finalize. Never redeploy on a manifest failure." }, null, 2)}\n`,
  );
}

async function manifest() {
  const url = rpcUrl();
  await chainId(url);
  const state = await readState();
  if (!state.accountFactory || !state.eventFactory || !state.event)
    throw new Error("Deployment state is incomplete; run `deploy` first");

  const blocks = [
    state.accountFactory.transactionHash,
    state.eventFactory.transactionHash,
    state.event.transactionHash,
  ].filter(Boolean);
  let highest = 0n;
  for (const hash of blocks) {
    const block = await receiptBlock(url, hash);
    if (block > highest) highest = block;
  }
  const finalized = await awaitFinality(url, highest);

  // Account manifest: the factory address alone is not trusted. DeploymentChain re-derives these
  // hashes at the finalized tag on every checkpoint and refuses to serve if they drift.
  const factory = state.accountFactory.address;
  const implementation = (
    await call(url, factory, "implementation()(address)", [], finalized)
  ).trim();
  if (!ADDRESS.test(implementation)) throw new Error("Factory returned no implementation address");
  const accountManifest = {
    version: 1,
    chainId: CHAIN_ID,
    factory,
    factoryCodeHash: await codeHashAt(url, factory, finalized),
    implementation,
    implementationCodeHash: await codeHashAt(url, implementation, finalized),
  };

  // Financial manifests: resolve components from the factory rather than from recorded state, so
  // the manifest describes what the chain says exists, not what we believe we deployed.
  const deployment = await call(
    url,
    state.eventFactory.address,
    "getDeployment(address,bytes32)((address,address,address,address))",
    [state.deployer, state.event.eventId],
    finalized,
  );
  const parts = deployment.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  if (parts.length !== 4 || new Set(parts.map((v) => v.toLowerCase())).size !== 4)
    throw new Error("Event components are incomplete or aliased");
  const [registry, ledger, router, vault] = parts;

  // Cross-check the on-chain wiring between components. The factory verifies this at deploy time;
  // re-verifying at the finalized tag means a manifest can never describe a half-bound event.
  const links = {
    "ledger.registry": [await call(url, ledger, "registry()(address)", [], finalized), registry],
    "ledger.router": [await call(url, ledger, "router()(address)", [], finalized), router],
    "ledger.vault": [await call(url, ledger, "vault()(address)", [], finalized), vault],
    "router.registry": [await call(url, router, "registry()(address)", [], finalized), registry],
    "router.ledger": [await call(url, router, "ledger()(address)", [], finalized), ledger],
    "vault.registry": [await call(url, vault, "registry()(address)", [], finalized), registry],
    "vault.ledger": [await call(url, vault, "ledger()(address)", [], finalized), ledger],
    "registry.asset": [await call(url, registry, "asset()(address)", [], finalized), state.asset],
  };
  for (const [field, [actual, expected]] of Object.entries(links))
    if (actual.trim().toLowerCase() !== expected.trim().toLowerCase())
      throw new Error(`${field} mismatch: chain says ${actual.trim()}, expected ${expected}`);
  const onChainEventId = (await call(url, registry, "eventId()(bytes32)", [], finalized)).trim();
  if (onChainEventId.toLowerCase() !== state.event.eventId.toLowerCase())
    throw new Error("registry.eventId does not match the deployed event ID");

  const deploymentBlock = state.event.blockNumber ?? highest.toString();
  const financialManifest = {
    schemaVersion: 1,
    chainId: CHAIN_ID,
    events: [
      {
        eventId: state.event.eventId.toLowerCase(),
        router,
        vault,
        ledger,
        asset: state.asset,
        deploymentBlock,
      },
    ],
  };

  // The independent verifier (§3.5) checks runtime code hashes for all four components, so it needs
  // a richer manifest than the relayer's routing manifest. Both are emitted from the same read.
  const verifierManifest = {
    chainId: CHAIN_ID,
    eventId: state.event.eventId.toLowerCase(),
    asset: state.asset,
    registry: { address: registry, runtimeCodeHash: await codeHashAt(url, registry, finalized) },
    ledger: { address: ledger, runtimeCodeHash: await codeHashAt(url, ledger, finalized) },
    router: { address: router, runtimeCodeHash: await codeHashAt(url, router, finalized) },
    vault: { address: vault, runtimeCodeHash: await codeHashAt(url, vault, finalized) },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}account-manifest.json`,
    `${JSON.stringify(accountManifest, null, 2)}\n`,
  );
  await writeFile(
    `${outDir}financial-manifest.json`,
    `${JSON.stringify(financialManifest, null, 2)}\n`,
  );
  await writeFile(
    `${outDir}verifier-manifest.json`,
    `${JSON.stringify(verifierManifest, null, 2)}\n`,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        passed: true,
        finalizedBlock: finalized.toString(),
        explorer: {
          accountFactory: `https://testnet.monadexplorer.com/address/${factory}`,
          eventFactory: `https://testnet.monadexplorer.com/address/${state.eventFactory.address}`,
          registry: `https://testnet.monadexplorer.com/address/${registry}`,
          ledger: `https://testnet.monadexplorer.com/address/${ledger}`,
          router: `https://testnet.monadexplorer.com/address/${router}`,
          vault: `https://testnet.monadexplorer.com/address/${vault}`,
        },
        written: ["account-manifest.json", "financial-manifest.json", "verifier-manifest.json"],
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Deploys the ReclaimTrigger that scheduled CRE reports call to return expired reserves, bound to the
 * event's vault from the verifier manifest and to one CRE forwarder (`RECLAIM_TRIGGER_FORWARDER`,
 * `simulation` by default). Resumable like `deploy`: an existing trigger for that forwarder is never
 * redeployed. Its immutables are read back at the finalized block before the manifest records it.
 */
async function reclaimTrigger() {
  const url = rpcUrl();
  await chainId(url);
  const state = await readState();
  if (!state.event) throw new Error("Deployment state is incomplete; run `deploy` first");
  const kind = process.env.RECLAIM_TRIGGER_FORWARDER ?? "simulation";
  const forwarder = CRE_FORWARDERS[kind];
  if (!forwarder)
    throw new Error(`RECLAIM_TRIGGER_FORWARDER must be one of ${Object.keys(CRE_FORWARDERS)}`);
  const forwarderCode = await cast(["code", "--rpc-url", url, forwarder]);
  if (!forwarderCode || forwarderCode === "0x")
    throw new Error(`CRE ${kind} forwarder ${forwarder} has no bytecode on this chain`);
  const verifierManifest = JSON.parse(await readFile(`${outDir}verifier-manifest.json`, "utf8"));
  if (verifierManifest.eventId !== state.event.eventId.toLowerCase())
    throw new Error("verifier-manifest.json describes a different event; run `manifest` first");
  const vault = verifierManifest.vault.address;

  state.reclaimTriggers ??= {};
  if (!state.reclaimTriggers[kind]) {
    const created = await forgeCreate(url, "src/automation/ReclaimTrigger.sol:ReclaimTrigger", [
      forwarder,
      vault,
    ]);
    state.reclaimTriggers[kind] = { forwarder, vault, ...created };
    await writeState(state);
  }
  const deployed = state.reclaimTriggers[kind];
  if (deployed.forwarder !== forwarder || deployed.vault !== vault)
    throw new Error(`Recorded ${kind} trigger is bound to a different forwarder or vault`);

  const blockNumber = await receiptBlock(url, deployed.transactionHash);
  const finalized = await awaitFinality(url, blockNumber);
  const bindings = {
    forwarder: [
      await call(url, deployed.address, "forwarder()(address)", [], finalized),
      forwarder,
    ],
    vault: [await call(url, deployed.address, "vault()(address)", [], finalized), vault],
  };
  for (const [field, [actual, expected]] of Object.entries(bindings))
    if (actual.trim().toLowerCase() !== expected.toLowerCase())
      throw new Error(
        `trigger.${field} mismatch: chain says ${actual.trim()}, expected ${expected}`,
      );

  const manifestPath = `${outDir}reclaim-trigger-manifest.json`;
  let manifestFile = { schemaVersion: 1, chainId: CHAIN_ID, eventId: verifierManifest.eventId };
  try {
    manifestFile = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (manifestFile.eventId !== verifierManifest.eventId)
    throw new Error("reclaim-trigger-manifest.json describes a different event");
  manifestFile.triggers = {
    ...manifestFile.triggers,
    [kind]: {
      address: deployed.address,
      forwarder,
      vault,
      runtimeCodeHash: await codeHashAt(url, deployed.address, finalized),
      transactionHash: deployed.transactionHash,
      blockNumber: blockNumber.toString(),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifestFile, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        passed: true,
        forwarder: kind,
        trigger: deployed.address,
        explorer: `https://testnet.monadexplorer.com/address/${deployed.address}`,
        written: ["reclaim-trigger-manifest.json"],
      },
      null,
      2,
    )}\n`,
  );
}

// BlockVision's Sourcify service backs contract verification on the Monad explorers; one endpoint
// serves both networks and infers the network from the chain ID.
const SOURCIFY = "https://sourcify-api-monad.blockvision.org";

/**
 * Publishes source for every deployed contract so the explorer can independently recompile it and
 * compare against the deployed bytecode. This is a separate claim from the manifests: a manifest
 * proves which bytecode is running, verification proves which source produced it.
 *
 * `foundry.toml` sets bytecode_hash = "none" and cbor_metadata = false, so there is no embedded
 * metadata hash to match on and Sourcify has to establish the match from runtime bytecode alone.
 * A result of anything other than a full runtime match is therefore reported, not assumed benign.
 */
async function verify() {
  const url = rpcUrl();
  await chainId(url);
  const state = await readState();
  if (!state.accountFactory || !state.eventFactory || !state.event)
    throw new Error("Deployment state is incomplete; run `deploy` first");
  const verifierManifest = JSON.parse(await readFile(`${outDir}verifier-manifest.json`, "utf8"));
  const accountManifest = JSON.parse(await readFile(`${outDir}account-manifest.json`, "utf8"));

  const targets = [
    ["src/accounts/AccountFactory.sol:AccountFactory", accountManifest.factory],
    ["src/accounts/OpenBalanceAccount.sol:OpenBalanceAccount", accountManifest.implementation],
    ["src/payments/EventFactory.sol:EventFactory", state.eventFactory.address],
    ["src/payments/EventRegistry.sol:EventRegistry", verifierManifest.registry.address],
    ["src/payments/SettlementLedger.sol:SettlementLedger", verifierManifest.ledger.address],
    ["src/payments/ExactPayRouter.sol:ExactPayRouter", verifierManifest.router.address],
    ["src/payments/ResilienceVault.sol:ResilienceVault", verifierManifest.vault.address],
    ...Object.values(state.reclaimTriggers ?? {}).map((trigger) => [
      "src/automation/ReclaimTrigger.sol:ReclaimTrigger",
      trigger.address,
    ]),
  ];

  const results = [];
  for (const [contract, address] of targets) {
    const name = contract.split(":")[1];
    let jobId;
    try {
      const output = await foundry(
        "forge",
        [
          "verify-contract",
          address,
          contract,
          "--chain",
          String(CHAIN_ID),
          "--verifier",
          "sourcify",
          "--verifier-url",
          `${SOURCIFY}/`,
          "--rpc-url",
          url,
        ],
        { cwd: contractsDir },
      );
      jobId = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    } catch (error) {
      // An address already verified by an earlier run is a success, not a failure to re-establish.
      if (/already verified/i.test(error.message)) {
        results.push({ name, address, status: "already verified" });
        continue;
      }
      results.push({
        name,
        address,
        status: "submission failed",
        detail: error.message.slice(-200),
      });
      continue;
    }
    if (!jobId) {
      results.push({ name, address, status: "no job id returned" });
      continue;
    }
    results.push({ name, address, jobId, ...(await awaitVerification(jobId)) });
  }

  const verified = results.filter(
    (item) => item.status === "match" || item.status === "already verified",
  );
  const report = {
    passed: verified.length === targets.length,
    verified: `${verified.length}/${targets.length}`,
    sourcify: SOURCIFY,
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

async function awaitVerification(jobId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${SOURCIFY}/v2/verify/${jobId}`);
    if (response.ok) {
      const body = await response.json();
      if (body.isJobCompleted) {
        const match = body.contract?.runtimeMatch ?? body.contract?.match;
        if (match === "match") return { status: "match", matchId: body.contract?.matchId };
        // Sourcify reports an address verified by an earlier run as a job error rather than as a
        // match. The contract is verified, so re-running must stay idempotent and not report failure.
        if (body.error?.customCode === "already_verified") return { status: "already verified" };
        return { status: `incomplete match: ${match ?? "none"}`, detail: body.error ?? undefined };
      }
    }
    if (Date.now() > deadline) return { status: "timed out awaiting verification" };
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

const commands = { preflight, deploy, manifest, verify, "reclaim-trigger": reclaimTrigger };
const command = process.argv[2];
if (!commands[command]) {
  process.stderr.write(`Usage: deploy-testnet.mjs ${Object.keys(commands).join(" | ")}\n`);
  process.exitCode = 1;
} else {
  await commands[command]().catch((error) => {
    process.stderr.write(`${JSON.stringify({ passed: false, command, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
