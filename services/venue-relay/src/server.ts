import { readFile } from "node:fs/promises";
import { startTelemetry } from "@openbalance/observability";
import { buildVenueRelayApp } from "./app.js";
import { loadVenueRelayEnvironment } from "./config.js";
import { loadTerminalSnapshotDirectory } from "./directory.js";
import { VenueRelayJournal } from "./journal.js";

async function loadRelayKey(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 32) return Buffer.from(bytes);
  const text = bytes.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  throw new Error("Venue relay key file must contain exactly 32 raw bytes or 64 hex characters");
}

const environment = loadVenueRelayEnvironment(process.env);
const telemetry = await startTelemetry({
  serviceName: "openbalance-venue-relay",
  metricsPort: Number(process.env.METRICS_PORT ?? "9466"),
  ...(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    ? { otlpTraceUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }
    : {}),
});
const directory = await loadTerminalSnapshotDirectory(environment.TERMINAL_SNAPSHOT_PATH);
const key = await loadRelayKey(environment.VENUE_RELAY_KEY_PATH);
const journal = new VenueRelayJournal(environment.VENUE_RELAY_DATABASE_PATH, key);
key.fill(0);
const app = await buildVenueRelayApp({
  journal,
  directory,
  audience: environment.TERMINAL_INGRESS_AUDIENCE,
  maximumClockSkewSeconds: environment.TERMINAL_MAXIMUM_CLOCK_SKEW_SECONDS,
  readiness: async () => {
    journal.assertReady();
  },
});
app.addHook("onClose", async () => {
  journal.close();
  await telemetry.shutdown();
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: environment.HOST, port: environment.PORT });
