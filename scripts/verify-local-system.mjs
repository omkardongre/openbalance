import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [
  ["ephemeral-anvil-deployment", "pnpm", ["verify:local-chain"]],
  ["account-ownership-scenario", "pnpm", ["verify:scenario"]],
  ["relay-process-scenario", "pnpm", ["verify:relay"]],
  ["static", "pnpm", ["check"]],
  ["protocol-and-contracts", "pnpm", ["test"]],
  ["database-crash-replay", "pnpm", ["verify:postgres"]],
  ["application-build", "pnpm", ["build"]],
  ["native-terminal", "pnpm", ["android:build"]],
  ["infrastructure", "terraform", ["-chdir=infra/terraform", "validate"]],
];

function run(command, args) {
  const startedAt = new Date().toISOString();
  const before = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, shell: false, stdio: "inherit" });
    child.once("error", (error) =>
      resolve({
        startedAt,
        durationMs: performance.now() - before,
        exitCode: null,
        error: error.constructor.name,
      }),
    );
    child.once("exit", (code, signal) =>
      resolve({ startedAt, durationMs: performance.now() - before, exitCode: code, signal }),
    );
  });
}

const outputPath = process.argv[2];
if (!outputPath) {
  process.stderr.write("Usage: node scripts/verify-local-system.mjs <result.json>\n");
  process.exitCode = 64;
} else {
  const results = [];
  for (const [name, command, args] of checks) {
    const result = await run(command, args);
    results.push({ name, ...result });
    if (result.exitCode !== 0) break;
  }
  const report = {
    schemaVersion: 1,
    environment: "local",
    startedAt: results[0]?.startedAt,
    completedAt: new Date().toISOString(),
    passed: results.length === checks.length && results.every((result) => result.exitCode === 0),
    scenarios: {
      accountOwnership: "scripts/verify-scenario.mjs (account-ownership)",
      offlineReserve: "scripts/verify-scenario.mjs (offline-reserve)",
      relayProcessSettlement: "scripts/verify-relay-scenario.mjs",
      terminalRestart: "packages/terminal/test/journal.test.ts",
      duplicateAndOrdering: "packages/terminal/test/journal.test.ts",
      relayUncertainAcknowledgement: "packages/terminal/test/upload.test.ts",
      settlementUncertainBroadcast: "services/venue-relay/test/settlement.test.ts",
      expiryAndTrustedTime: "packages/terminal/test/clock.test.ts",
      databaseMigrationReplay: "scripts/verify-postgres.mjs",
    },
    limitations: [
      "This local report does not establish public-network, physical-device, or external-system correctness.",
      "Scenario references are verified test executables, not claims about deployed processes.",
    ],
    results,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (!report.passed) process.exitCode = 1;
}
