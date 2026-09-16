import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OfflineReserveOptions, prepareOfflineReserve } from "./event-scenario.js";

const relayEntrypoint = fileURLToPath(
  new URL("../../../services/venue-relay/dist/server.js", import.meta.url),
);
const settlementEntrypoint = fileURLToPath(
  new URL("../../../services/venue-relay/dist/settlement-worker-server.js", import.meta.url),
);

export type RelayScenarioOptions = OfflineReserveOptions & { workspaceRoot: string };

export type RelayScenarioResult = {
  kind: "relay-process";
  chainId: number;
  vault: string;
  account: string;
  ledgerCustody: string;
  settledUnits: string;
  reservedAfterSettlement: string;
  acceptedState: string;
  settledState: string;
  duplicateState: string;
  duplicateRejected: boolean;
  conflictRejected: boolean;
  restartSettledState: string;
};

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return (address as { port: number }).port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Venue relay did not become healthy");
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

/**
 * Boots the venue relay and its settlement worker as real processes, delivers an authenticated
 * offline receipt over HTTP, and proves ordered settlement, idempotent replay, conflicting-replay
 * rejection, and durable recovery after a relay restart.
 */
export async function runRelayProcessScenario(
  options: RelayScenarioOptions,
): Promise<RelayScenarioResult> {
  const context = await prepareOfflineReserve(options);
  const directory = await mkdtemp(join(tmpdir(), "openbalance-relay-scenario-"));
  const port = await availablePort();
  const host = "127.0.0.1";
  const databasePath = join(directory, "relay.sqlite");
  const keyPath = join(directory, "relay.key");
  const snapshotPath = join(directory, "terminals.json");
  const settlementKeyPath = join(directory, "settlement.key");
  const relayUrl = `http://${host}:${port}/v1/vouchers`;
  const nowSeconds = Math.floor(Date.now() / 1_000);

  await writeFile(keyPath, randomBytes(32).toString("hex"), "utf8");
  await writeFile(settlementKeyPath, options.deployerPrivateKey, "utf8");
  await writeFile(
    snapshotPath,
    JSON.stringify({
      schemaVersion: 1,
      chainId: context.chainId,
      registry: context.registry,
      vault: context.vault,
      finalizedBlockNumber: "0",
      finalizedBlockHash: `0x${"11".repeat(32)}`,
      generatedAt: nowSeconds,
      expiresAt: nowSeconds + 3_600,
      terminals: [
        {
          terminalId: context.terminalId,
          keyVersion: "1",
          channelId: context.channelId,
          signer: context.terminalSignerAddress,
          enabled: true,
          validAfter: nowSeconds - 60,
          validUntil: nowSeconds + 3_600,
        },
      ],
    }),
    "utf8",
  );

  // Each service validates its own configuration strictly, so child processes receive only the
  // variables their schema declares rather than the full ambient environment.
  const relayEnvironment = {
    HOST: host,
    PORT: String(port),
    VENUE_RELAY_DATABASE_PATH: databasePath,
    VENUE_RELAY_KEY_PATH: keyPath,
    TERMINAL_SNAPSHOT_PATH: snapshotPath,
    TERMINAL_INGRESS_AUDIENCE: relayUrl,
  };
  const settlementEnvironment = {
    VENUE_RELAY_DATABASE_PATH: databasePath,
    VENUE_RELAY_KEY_PATH: keyPath,
    VENUE_RELAY_RPC_URL: options.rpcUrl,
    VENUE_RELAY_CHAIN_ID: String(context.chainId),
    VENUE_RELAY_CHAIN_NAME: "Local Anvil",
    VENUE_RELAY_VAULT_ADDRESS: context.vault,
    VENUE_RELAY_DEPLOYMENT_BLOCK: "0",
    // Local Anvil reports `finalized` as genesis, so the local policy follows `latest`.
    VENUE_RELAY_FINALITY_TAG: "latest",
    VENUE_RELAY_SETTLEMENT_PRIVATE_KEY_PATH: settlementKeyPath,
    VENUE_RELAY_SETTLEMENT_WORKER_ID: "scenario-worker",
    VENUE_RELAY_SETTLEMENT_POLL_MS: "1000",
  };

  let relay: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let relayLog = "";
  let workerLog = "";
  const startRelay = async () => {
    relay = spawn(process.execPath, [relayEntrypoint], {
      cwd: options.workspaceRoot,
      env: relayEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    relay.stdout?.on("data", (value) => {
      relayLog += value;
    });
    relay.stderr?.on("data", (value) => {
      relayLog += value;
    });
    try {
      await waitForHealth(`http://${host}:${port}/health`);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "relay unhealthy"}: ${relayLog.slice(-800)}`,
      );
    }
  };

  try {
    await startRelay();
    worker = spawn(process.execPath, [settlementEntrypoint], {
      cwd: options.workspaceRoot,
      env: settlementEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout?.on("data", (value) => {
      workerLog += value;
    });
    worker.stderr?.on("data", (value) => {
      workerLog += value;
    });

    const accepted = await post(relayUrl, await context.relayAudience(relayUrl));
    if (accepted.status !== 201 || accepted.json.state !== "PENDING")
      throw new Error(
        `Relay did not accept the receipt: ${accepted.status} ${accepted.json.state}`,
      );

    let settledState = "PENDING";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const poll = await post(relayUrl, await context.relayAudience(relayUrl));
      if (poll.status !== 200 && poll.status !== 201)
        throw new Error(`Relay poll failed: ${poll.status}`);
      settledState = poll.json.state;
      if (settledState === "SETTLED") break;
      if (settledState === "QUARANTINED") throw new Error("Relay quarantined the receipt");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (settledState !== "SETTLED")
      throw new Error(`Receipt did not settle in time. Worker log: ${workerLog.slice(-800)}`);

    const ledgerCustody = await context.readLedgerCustody();
    const reservedAfterSettlement = await context.readReserved();
    if (ledgerCustody !== context.grossUnits)
      throw new Error("On-chain ledger custody does not equal the settled gross");
    if (reservedAfterSettlement !== context.reserveUnits - context.grossUnits)
      throw new Error("On-chain reserve accounting does not match the settled voucher");

    const duplicate = await post(relayUrl, await context.relayAudience(relayUrl));
    const duplicateRejected =
      duplicate.json.duplicate === true && duplicate.json.state === "SETTLED";

    const conflicting = await context.relayAudience(relayUrl);
    (conflicting.receipt as { receiptId: string }).receiptId = "receipt:conflicting";
    const conflict = await post(relayUrl, conflicting);
    const conflictRejected = conflict.status >= 400;

    await stop(relay as ChildProcess);
    await startRelay();
    const afterRestart = await post(relayUrl, await context.relayAudience(relayUrl));
    const restartSettledState = afterRestart.json.state;
    if (restartSettledState !== "SETTLED")
      throw new Error(
        `Relay did not retain settled state across a restart: ${afterRestart.status} ${JSON.stringify(afterRestart.json)}`,
      );

    return {
      kind: "relay-process",
      chainId: context.chainId,
      vault: context.vault,
      account: context.account,
      ledgerCustody: ledgerCustody.toString(),
      settledUnits: context.grossUnits.toString(),
      reservedAfterSettlement: reservedAfterSettlement.toString(),
      acceptedState: accepted.json.state,
      settledState,
      duplicateState: duplicate.json.state,
      duplicateRejected,
      conflictRejected,
      restartSettledState,
    };
  } finally {
    if (worker) await stop(worker);
    if (relay) await stop(relay);
    await rm(directory, { recursive: true, force: true });
  }
}
