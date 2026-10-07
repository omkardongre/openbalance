// Populates the runtime secrets that Terraform declares as empty containers.
//
// Terraform creates secret containers but deliberately never their values: a value passed as a
// Terraform variable is recorded in plan output and state, so the container and its contents are
// owned by different steps on purpose.
//
// Two rules shape this script:
//
//   A signing key is never replaced. Once a key exists it may already hold funds and may already be
//   the authority recorded on chain, so overwriting it would orphan both. Rotation is a deliberate,
//   separate act with its own funding and re-authorisation, not a side effect of re-running setup.
//
//   A new version is added only when the value actually differs. Secret versions are immutable and
//   billed, and a fresh version on every run destroys the audit signal of a version appearing at all.
//
// Secret material is passed to gcloud on stdin rather than as an argument, so it never appears in the
// process table, and generated keys exist only in memory: nothing here writes a key to disk.
//
// Usage:
//   node scripts/populate-secrets.mjs            # report what would change
//   node scripts/populate-secrets.mjs --apply    # write the missing versions

import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { foundry } from "./foundry-bin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const deployments = join(root, "deployments", "testnet");

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "openbalance-hackathon";
// Required, and passed on every gcloud call: this machine holds several authenticated identities, and
// the ambient active account can change underneath a run. An explicit flag cannot.
const ACCOUNT = process.env.GOOGLE_CLOUD_ACCOUNT;
if (!ACCOUNT) throw new Error("Set GOOGLE_CLOUD_ACCOUNT to the identity that owns this project.");
const GCLOUD_SCOPE = [`--project=${PROJECT}`, `--account=${ACCOUNT}`];
const ENVIRONMENT = process.env.OPENBALANCE_ENVIRONMENT ?? "testnet";
const PREFIX = `openbalance-${ENVIRONMENT}`;
const CHAIN_ID = 10_143;

const apply = process.argv.includes("--apply");

// A private key the services will load. The loader requires exactly this shape, so it is validated
// here too: a malformed key uploaded now fails much later, inside a container, as a startup crash.
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      env: process.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
        ? resolve(stdout)
        : reject(new Error(`${command} ${args[0] ?? ""} failed: ${(stderr || stdout).trim()}`)),
    );
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

/** Current value of a secret, or null when it has no versions yet. */
async function currentValue(name) {
  try {
    return await run("gcloud", [
      "secrets",
      "versions",
      "access",
      "latest",
      ...GCLOUD_SCOPE,
      `--secret=${name}`,
    ]);
  } catch (error) {
    // Distinguish "no versions yet", which is the expected initial state, from a real failure such as
    // a missing container or a denied permission, which must not be silently treated as empty.
    if (/NOT_FOUND|no versions|has no enabled/i.test(String(error.message))) return null;
    throw error;
  }
}

async function addVersion(name, value) {
  await run(
    "gcloud",
    ["secrets", "versions", "add", name, ...GCLOUD_SCOPE, "--data-file=-"],
    value,
  );
}

// Loaded here rather than sourced by the shell. A connection string carries `&` between query
// parameters, which an unquoted `source` splits into a background job, so shell sourcing both loses
// the value and echoes the credential to the terminal.
function loadEnvironmentFile() {
  const file = process.env.OPENBALANCE_ENV_FILE ?? join(root, `.env.${ENVIRONMENT}`);
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value.trim();
}

/** Reads a manifest, failing closed if it is not the chain these services are being pointed at. */
async function manifest(file) {
  const raw = await readFile(join(deployments, file), "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.chainId !== CHAIN_ID)
    throw new Error(`${file} declares chain ${parsed.chainId}, expected ${CHAIN_ID}.`);
  return JSON.stringify(parsed);
}

async function generateKey() {
  const output = await foundry("cast", ["wallet", "new", "--json"]);
  // Current Foundry wraps command output in a result envelope rather than returning the payload
  // directly, so the wallet is under `data`. Older versions returned the array alone; both are
  // accepted because the shape is not worth depending on.
  const parsed = JSON.parse(output);
  const payload = parsed?.data ?? parsed;
  const created = Array.isArray(payload) ? payload[0] : payload;
  const key = String(created?.private_key ?? created?.privateKey ?? "").toLowerCase();
  // Validated rather than trusted: an unrecognised shape would otherwise upload the string
  // "undefined" as a signing key, and that would only surface later as a container crash.
  if (!PRIVATE_KEY.test(key))
    throw new Error("Generated key is not a 0x-prefixed 32-byte hex value.");
  return key;
}

async function addressOf(key) {
  const output = await foundry("cast", ["wallet", "address", "--private-key", key]);
  const parsed = JSON.parse(
    output.trimStart().startsWith("{") || output.trimStart().startsWith("[")
      ? output
      : JSON.stringify({ data: output.trim() }),
  );
  const payload = parsed?.data ?? parsed;
  const address = String(Array.isArray(payload) ? payload[0] : payload).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error("Could not derive an address for the generated key.");
  return address;
}

const results = [];

/**
 * A value this script can recompute on every run, so a difference means the source of truth moved and
 * the secret should follow it.
 */
async function reconcile(shortName, value, note) {
  const name = `${PREFIX}-${shortName}`;
  const existing = await currentValue(name);
  if (existing !== null && existing.trim() === value.trim()) {
    results.push({ secret: shortName, action: "unchanged", note });
    return;
  }
  const action = existing === null ? "created" : "updated";
  if (apply) await addVersion(name, value);
  results.push({ secret: shortName, action: apply ? action : `would be ${action}`, note });
}

/**
 * A value that cannot be recomputed. Generated once if absent, then left alone forever, because the
 * existing key may hold funds or already be an authority recorded on chain.
 */
async function ensureSigningKey(shortName, purpose) {
  const name = `${PREFIX}-${shortName}`;
  const existing = await currentValue(name);
  if (existing !== null) {
    const key = existing.trim();
    const address = PRIVATE_KEY.test(key) ? await addressOf(key) : "unreadable";
    results.push({ secret: shortName, action: "kept", address, note: purpose });
    return;
  }
  if (!apply) {
    results.push({ secret: shortName, action: "would be generated", note: purpose });
    return;
  }
  const key = await generateKey();
  const address = await addressOf(key);
  await addVersion(name, key);
  results.push({ secret: shortName, action: "generated", address, note: purpose, fund: true });
}

/**
 * Ed25519 key the API signs terminal time samples with. Generated once and kept: its public half is
 * compiled into every terminal build, so replacing it silently would leave installed terminals unable
 * to refresh trusted time. Only the public half is printed.
 */
async function ensureTimeAuthorityKey() {
  const shortName = "time-authority";
  const name = `${PREFIX}-${shortName}`;
  const note = "api: signs terminal time; pin the public key into terminal builds";
  const existing = await currentValue(name);
  const publicKeyOf = (pem) =>
    createPublicKey(createPrivateKey(pem))
      .export({ type: "spki", format: "der" })
      .toString("base64");
  if (existing !== null) {
    results.push({ secret: shortName, action: "kept", publicKey: publicKeyOf(existing), note });
    return;
  }
  if (!apply) {
    results.push({ secret: shortName, action: "would be generated", note });
    return;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await addVersion(name, pem);
  results.push({ secret: shortName, action: "generated", publicKey: publicKeyOf(pem), note });
}

loadEnvironmentFile();

// The RPC URL embeds a provider API key, which is why it is a secret rather than a Terraform variable.
await reconcile("database-url", requireEnv("DATABASE_URL"), "managed Postgres connection");
await reconcile("operational-rpc-url", requireEnv("ACCOUNT_RPC_URL"), "operational RPC provider");
await reconcile(
  "account-manifest",
  await manifest("account-manifest.json"),
  "account factory binding",
);
await reconcile(
  "event-manifest",
  await manifest("financial-manifest.json"),
  "event contract binding",
);
await reconcile(
  "checkout-manifest",
  await manifest("checkout-manifest.json"),
  "checkout policy the API accepts orders under",
);

// Separate keys on purpose. The relayer and the financial worker each reserve nonces for their own
// signing address independently, so one shared address would let them issue colliding nonces, which
// the chain resolves by dropping a transaction rather than by reporting an error.
// From the Envio dashboard; a free token, but still a credential, so a secret rather than a variable.
await reconcile(
  "envio-api-token",
  requireEnv("ENVIO_API_TOKEN"),
  "indexer: Envio HyperSync log source",
);

await ensureSigningKey("sponsor-signer", "relayer: sponsors account deployment (needs MON)");
await ensureSigningKey("financial-signer", "financial worker: money operations (needs MON)");
await ensureSigningKey(
  "faucet-signer",
  "api: dispenses test balance (needs MON and settlement asset)",
);
await ensureTimeAuthorityKey();

const width = Math.max(...results.map((entry) => entry.secret.length));
process.stdout.write(`\n${apply ? "Applied" : "Dry run"} against ${PROJECT} (${ENVIRONMENT})\n\n`);
for (const entry of results) {
  process.stdout.write(`  ${entry.secret.padEnd(width)}  ${entry.action}\n`);
  if (entry.address) process.stdout.write(`  ${" ".repeat(width)}  address ${entry.address}\n`);
  if (entry.publicKey)
    process.stdout.write(`  ${" ".repeat(width)}  public key ${entry.publicKey}\n`);
  process.stdout.write(`  ${" ".repeat(width)}  ${entry.note}\n`);
}

const funding = results.filter((entry) => entry.fund);
if (funding.length) {
  process.stdout.write(
    "\nThese addresses were created empty and must be funded before the journey will succeed:\n",
  );
  for (const entry of funding) process.stdout.write(`  ${entry.address}  ${entry.note}\n`);
}
if (!apply) process.stdout.write("\nNo changes written. Re-run with --apply.\n");
