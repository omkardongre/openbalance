// Applies database migrations to a remote environment using the published release images.
//
// The images are run rather than the local build, so the schema is created by exactly the bytes that
// will serve traffic. A locally built migration can differ from the released one, and a schema applied
// by code that is not the deployed code is a silent mismatch waiting to surface as a runtime error.
//
// Order is fixed and sequential (§Startup order): later migrations reference tables earlier ones
// create, so running them concurrently would fail on ordering rather than on anything meaningful.
//
// The connection string is handed to the container through a mode-0600 environment file that is
// removed afterwards, not through a command-line argument, so it never appears in the process table.
//
// Usage:
//   node scripts/migrate-remote.mjs                  # report the plan
//   node scripts/migrate-remote.mjs --apply          # run the migrations

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tfvars = join(root, "infra", "terraform", "testnet.tfvars");
const ENVIRONMENT = process.env.OPENBALANCE_ENVIRONMENT ?? "testnet";
const apply = process.argv.includes("--apply");

// `integrations` is omitted: it is not deployed, and its schema is only meaningful alongside the
// partner credentials it needs, so creating its tables now would claim readiness that does not exist.
const ORDER = ["api", "indexer", "relayer"];

// Each service reads the DSN under its own name. The same database backs all of them (§5.3 separates
// environments, not services), so every variable is set to the same value.
const DSN_VARIABLES = [
  "DATABASE_URL",
  "INDEXER_DATABASE_URL",
  "API_DATABASE_URL",
  "INTEGRATION_DATABASE_URL",
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      env: process.env,
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let output = "";
    if (options.quiet) {
      child.stdout.on("data", (value) => {
        output += value;
      });
      child.stderr.on("data", (value) => {
        output += value;
      });
    }
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${command} ${args.slice(0, 2).join(" ")} failed${options.quiet ? `: ${output.trim()}` : ""}`,
            ),
          ),
    );
  });
}

/** Image references are read from the deployment inputs so migrations cannot run a different build. */
async function images() {
  const contents = await readFile(tfvars, "utf8");
  const resolved = {};
  for (const service of ORDER) {
    const direct = contents.match(new RegExp(`^${service}_image\\s*=\\s*"([^"]+)"`, "m"));
    const mapped = contents.match(new RegExp(`^\\s*${service}\\s*=\\s*"([^"]+)"`, "m"));
    const reference = direct?.[1] ?? mapped?.[1];
    if (!reference) throw new Error(`No image reference found for '${service}' in ${tfvars}.`);
    if (reference === "PENDING") throw new Error(`Image for '${service}' is still PENDING.`);
    if (!reference.includes("@sha256:"))
      throw new Error(`Image for '${service}' is not pinned to a digest: ${reference}`);
    resolved[service] = reference;
  }
  return resolved;
}

process.loadEnvFile(join(root, `.env.${ENVIRONMENT}`));
const dsn = process.env.DATABASE_URL;
if (!dsn) throw new Error("Missing required environment variable: DATABASE_URL");

const resolved = await images();

process.stdout.write(
  `\n${apply ? "Applying" : "Planned"} migrations for ${ENVIRONMENT}, in order:\n`,
);
for (const service of ORDER) process.stdout.write(`  ${service}\n`);

if (!apply) {
  process.stdout.write("\nNo migrations run. Re-run with --apply.\n");
  process.exit(0);
}

const registry = resolved[ORDER[0]].split("/")[0];
await run("gcloud", ["auth", "configure-docker", registry, "--quiet"], { quiet: true });

const directory = await mkdtemp(join(tmpdir(), "openbalance-migrate-"));
const environmentFile = join(directory, "migrate.env");
try {
  await writeFile(
    environmentFile,
    `${DSN_VARIABLES.map((name) => `${name}=${dsn}`).join("\n")}\n`,
    {
      mode: 0o600,
    },
  );

  for (const service of ORDER) {
    process.stdout.write(`\n=== ${service} ===\n`);
    await run("docker", [
      "run",
      "--rm",
      "--env-file",
      environmentFile,
      "--env",
      "OPENBALANCE_PROCESS=migrate",
      resolved[service],
    ]);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

process.stdout.write("\nMigrations complete.\n");
