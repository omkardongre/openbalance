import { readFile } from "node:fs/promises";
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
const directory = await loadTerminalSnapshotDirectory(environment.TERMINAL_SNAPSHOT_PATH);
const key = await loadRelayKey(environment.VENUE_RELAY_KEY_PATH);
const journal = new VenueRelayJournal(environment.VENUE_RELAY_DATABASE_PATH, key);
key.fill(0);
const app = await buildVenueRelayApp({
  journal,
  directory,
  audience: environment.TERMINAL_INGRESS_AUDIENCE,
  maximumClockSkewSeconds: environment.TERMINAL_MAXIMUM_CLOCK_SKEW_SECONDS,
});
app.addHook("onClose", async () => journal.close());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: environment.HOST, port: environment.PORT });
