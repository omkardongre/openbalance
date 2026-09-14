import { Pool } from "pg";
import { loadIntegrationEnvironment, loadIntegrationMappings } from "./config.js";
import { ErpNextClient } from "./erpnext.js";
import { IntegrationJobJournal } from "./journal.js";
import { FinalizedPaymentImporter } from "./source.js";
import { IntegrationWorker } from "./worker.js";

const environment = loadIntegrationEnvironment(process.env);
const mappings = await loadIntegrationMappings(environment.INTEGRATION_MAPPING_PATH);
const pool = (connectionString: string, applicationName: string, max: number) =>
  new Pool({
    connectionString,
    application_name: applicationName,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
const state = pool(environment.INTEGRATION_DATABASE_URL, "openbalance-integration-state", 4);
const indexer = pool(environment.INDEXER_DATABASE_URL, "openbalance-integration-indexer", 2);
const api = pool(environment.API_DATABASE_URL, "openbalance-integration-api", 2);
const journal = new IntegrationJobJournal(state);
const importer = new FinalizedPaymentImporter(indexer, api, state, journal, mappings);
const erpNextInput: ConstructorParameters<typeof ErpNextClient>[0] = {
  baseUrl: environment.ERPNEXT_BASE_URL,
  apiKey: environment.ERPNEXT_API_KEY,
  apiSecret: environment.ERPNEXT_API_SECRET,
};
if (environment.ERPNEXT_METHOD) erpNextInput.method = environment.ERPNEXT_METHOD;
const worker = new IntegrationWorker(
  journal,
  new ErpNextClient(erpNextInput),
  environment.INTEGRATION_WORKER_ID,
);
const streams = [...new Set(mappings.map((mapping) => mapping.streamId))].sort();

await Promise.all([journal.assertReady(), importer.assertReady()]);

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true;
  });

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  while (!stopping) {
    let progressed = false;
    for (const streamId of streams) {
      const imported = await importer.importOnce(streamId, environment.INTEGRATION_IMPORT_LIMIT);
      progressed ||= imported > 0;
    }
    for (let delivered = 0; delivered < environment.INTEGRATION_DELIVERY_LIMIT; delivered += 1) {
      const outcome = await worker.runOnce();
      if (outcome === "IDLE") break;
      progressed = true;
    }
    if (!progressed) await pause(environment.INTEGRATION_POLL_INTERVAL_MS);
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "integration-worker",
      error: error instanceof Error ? error.constructor.name : "UnknownError",
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await Promise.all([state.end(), indexer.end(), api.end()]);
}
