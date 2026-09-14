import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const container = `openbalance-verification-${randomBytes(8).toString("hex")}`;
const password = randomBytes(32).toString("hex");
let created = false;
let active;
let interrupted = false;

function run(command, args, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    active = child;
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (active === child) active = undefined;
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} exited unsuccessfully`));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    active?.kill("SIGTERM");
  });
}

try {
  await run(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_DB=openbalance_test",
      "--health-cmd",
      "pg_isready -U postgres -d openbalance_test",
      "--health-interval",
      "1s",
      "--health-timeout",
      "2s",
      "--health-retries",
      "30",
      "postgres:16-alpine",
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
    true,
  );
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40 && !interrupted; attempt++) {
    const state = await run(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", container],
      process.env,
      true,
    );
    if (state === "healthy") {
      ready = true;
      break;
    }
    if (state === "unhealthy") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!ready || interrupted) throw new Error("Disposable PostgreSQL did not become ready");
  const binding = await run("docker", ["port", container, "5432/tcp"], process.env, true);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("Unexpected database binding");
  const url = `postgresql://postgres:${password}@${binding}/openbalance_test`;
  const env = {
    ...process.env,
    DATABASE_URL: url,
    INDEXER_DATABASE_URL: url,
    INTEGRATION_DATABASE_URL: url,
    OPERATIONS_TEST_DATABASE_URL: url,
    INDEXER_TEST_DATABASE_URL: url,
    INTEGRATION_TEST_DATABASE_URL: url,
    ENROLLMENT_TEST_DATABASE_URL: url,
    DEPLOYMENT_TEST_RPC_URL: "",
  };
  // Applying twice exercises checksum-protected migration replay as well as initial creation.
  for (let pass = 0; pass < 2; pass++) {
    for (const service of ["indexer", "api", "relayer", "integrations"]) {
      if (interrupted) throw new Error("Verification interrupted");
      await run("pnpm", ["--filter", `@openbalance/${service}`, "migrate"], env);
    }
  }
  for (const service of ["indexer", "api", "integrations"]) {
    if (interrupted) throw new Error("Verification interrupted");
    await run("pnpm", ["--filter", `@openbalance/${service}`, "test"], env);
  }
  console.log("PostgreSQL migration replay and database tests passed.");
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replaceAll(password, "[redacted]")
      : "Verification failed",
  );
  process.exitCode = 1;
} finally {
  if (created) {
    await run("docker", ["rm", "--force", "--volumes", container], process.env, true);
  }
}
