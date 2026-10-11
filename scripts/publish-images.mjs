#!/usr/bin/env node
// Builds every release image and publishes it to Artifact Registry pinned by digest.
//
// Why digests rather than tags: a tag names whichever bytes it currently points at, so a re-push or
// a rollback silently changes what a running service executes. A digest is the content itself and
// cannot be repointed. Tags are still published for human navigation, but the deployment inputs this
// script writes are always digests.
//
// The web image is deliberately excluded from the default set. Its NEXT_PUBLIC_* values are compiled
// into browser bundles at build time, and they are the deployed API/relayer URLs, which do not exist
// until those services are created. Building it with placeholder URLs would produce an image that
// looks releasable and cannot work, so the web image is built in a second pass once the request
// services report their URIs.
//
// Usage:
//   node scripts/publish-images.mjs                  # all service and worker images
//   node scripts/publish-images.mjs api relayer      # a named subset
//   node scripts/publish-images.mjs web              # after request-service URIs are known

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tfvars = join(root, "infra", "terraform", "testnet.tfvars");

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "openbalance-hackathon";
const REGION = process.env.GOOGLE_CLOUD_REGION ?? "us-central1";
const REPOSITORY = process.env.OPENBALANCE_IMAGE_REPOSITORY ?? "openbalance-testnet";
const HOST = `${REGION}-docker.pkg.dev`;
const PREFIX = `${HOST}/${PROJECT}/${REPOSITORY}`;

// `service` is the workspace package to build; `process` selects the runtime entrypoint inside it.
// Two images therefore share one package but run different processes, which is why the worker name
// and the service name are not interchangeable.
const TARGETS = {
  api: { service: "api", process: "server" },
  relayer: { service: "relayer", process: "server" },
  "venue-relay": { service: "venue-relay", process: "server" },
  indexer: { service: "indexer", process: "server" },
  integrations: { service: "integrations", process: "server" },
  "financial-worker": { service: "relayer", process: "financial-worker" },
  "venue-relay-settlement": { service: "venue-relay", process: "settlement-worker" },
  web: { dockerfile: "deploy/Dockerfile.web" },
};

// The tfvars key each image populates. Worker images live inside a map, so they are rewritten
// differently from the four top-level service variables.
const SERVICE_VARIABLES = {
  api: "api_image",
  relayer: "relayer_image",
  web: "web_image",
  "venue-relay": "venue_relay_image",
};
const WORKERS = new Set(["indexer", "integrations", "financial-worker", "venue-relay-settlement"]);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (options.capture) child.stdout.on("data", (value) => (stdout += value));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise(stdout.trim())
        : reject(new Error(`${command} ${args[0] ?? ""} exited with ${code}`)),
    );
  });
}

/** Reads the digest the registry actually stored, rather than trusting the local build output. */
async function publishedDigest(image, tag) {
  const digest = await run(
    "gcloud",
    [
      "artifacts",
      "docker",
      "images",
      "describe",
      `${image}:${tag}`,
      `--project=${PROJECT}`,
      "--format=value(image_summary.digest)",
    ],
    { capture: true },
  );
  if (!/^sha256:[0-9a-f]{64}$/.test(digest))
    throw new Error(`Registry returned no usable digest for ${image}:${tag}: ${digest}`);
  return digest;
}

async function build(name, tag) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown image: ${name}. Known: ${Object.keys(TARGETS).join(", ")}`);
  const image = `${PREFIX}/${name}`;

  const args = ["build", "--pull", "-t", `${image}:${tag}`];
  if (target.dockerfile) {
    args.push("-f", target.dockerfile);
    for (const variable of [
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_RELAYER_URL",
      "NEXT_PUBLIC_FINANCIAL_RPC_URL",
      "NEXT_PUBLIC_WEBAUTHN_RP_ID",
      "NEXT_PUBLIC_SETTLEMENT_ASSET",
      // Terminals sign every upload over this exact URL (the relayer's ingress audience), so the
      // setup codes /operations issues must carry the deterministic Cloud Run hostname.
      "NEXT_PUBLIC_TERMINAL_RELAY_URL",
    ]) {
      const value = process.env[variable];
      // A browser bundle compiled against a missing URL fails at runtime in the user's browser, far
      // from the build that caused it, so refuse to produce that image at all.
      if (!value) throw new Error(`${variable} is required to build a releasable web image.`);
      args.push("--build-arg", `${variable}=${value}`);
    }
    // The image tag names the build; the offline service worker embeds it as its cache version.
    args.push("--build-arg", `OPENBALANCE_BUILD_ID=${tag}`);
  } else {
    args.push(
      "-f",
      "deploy/Dockerfile.service",
      "--build-arg",
      `SERVICE=${target.service}`,
      "--build-arg",
      `PROCESS=${target.process}`,
    );
  }
  args.push(".");

  await run("docker", args);
  // Only the unique tag is pushed. The registry's immutable-tags policy rejects any second push to
  // `latest` once it has been pushed once, which would fail every rebuild after the first — and a
  // moving `latest` is exactly what immutability exists to prevent, so it is not pushed at all rather
  // than worked around.
  await run("docker", ["push", `${image}:${tag}`]);
  const digest = await publishedDigest(image, tag);
  return `${image}@${digest}`;
}

/** Rewrites only the image lines, so hand-maintained values in the same file are preserved. */
async function recordImages(published) {
  let contents = await readFile(tfvars, "utf8");
  for (const [name, reference] of Object.entries(published)) {
    const variable = SERVICE_VARIABLES[name];
    if (variable) {
      const pattern = new RegExp(`^(${variable}\\s*=\\s*).*$`, "m");
      if (!pattern.test(contents)) throw new Error(`No ${variable} entry in ${tfvars}`);
      contents = contents.replace(pattern, `$1"${reference}"`);
    } else if (WORKERS.has(name)) {
      const pattern = new RegExp(`^(\\s+${name}\\s*=\\s*).*$`, "m");
      if (!pattern.test(contents)) throw new Error(`No worker_images.${name} entry in ${tfvars}`);
      contents = contents.replace(pattern, `$1"${reference}"`);
    } else {
      throw new Error(`No deployment variable is defined for image ${name}`);
    }
  }
  await writeFile(tfvars, contents);
}

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(TARGETS).filter((name) => name !== "web");

// The tag must be unique to the bytes being published, not merely to the current commit: the
// registry's immutable-tags policy means republishing an already-used tag with different content is
// a hard rejection, and a working tree with uncommitted changes has content the last commit's SHA
// does not describe. A dirty tree is suffixed with the current time so it always gets a fresh tag.
const commit = await run("git", ["rev-parse", "--short=12", "HEAD"], { capture: true });
const dirty = (await run("git", ["status", "--porcelain"], { capture: true })).length > 0;
const tag = dirty ? `${commit}-dirty-${Date.now()}` : commit;
await run("gcloud", ["auth", "configure-docker", HOST, "--quiet"]);

const published = {};
for (const name of names) {
  process.stdout.write(`\n=== ${name} ===\n`);
  published[name] = await build(name, tag);
}

await recordImages(published);

process.stdout.write("\nPublished by digest:\n");
for (const [name, reference] of Object.entries(published))
  process.stdout.write(`  ${name}: ${reference}\n`);
process.stdout.write(`\nRecorded in ${tfvars}\n`);
