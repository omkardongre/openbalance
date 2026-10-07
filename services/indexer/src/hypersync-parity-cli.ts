import { Pool } from "pg";
import { loadIndexerConfig } from "./config.js";
import { decodeIndexedTransition, sortChainLogs } from "./events.js";
import { HyperSyncLogClient } from "./hypersync.js";

/**
 * Parity check between Envio HyperSync and what the indexer has already committed.
 *
 * Reads every log the three contracts emitted from the deployment block up to the stored finalized
 * cursor through HyperSync, decodes them with the indexer's own decoder, and compares the resulting
 * transitions one by one (identity, block hash, transaction, log index, payload) with
 * `finalized_chain_logs`. Exit code 0 means HyperSync reproduces the committed history exactly.
 * Read only: it never writes to the database.
 */
const CHUNK_BLOCKS = 250_000n;

async function main() {
  const config = loadIndexerConfig(process.env);
  if (!config.hypersync) throw new Error("INDEXER_HYPERSYNC_URL and ENVIO_API_TOKEN are required");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 20_000,
  });
  try {
    const cursor = await pool.query<{ block_number: string }>(
      "SELECT block_number FROM indexer_cursors WHERE stream_id=$1",
      [config.streamId],
    );
    const cursorBlock = cursor.rows[0] ? BigInt(cursor.rows[0].block_number) : null;
    if (cursorBlock === null)
      throw new Error("The indexer has no committed cursor for this stream");

    const client = new HyperSyncLogClient({
      url: config.hypersync.url,
      apiToken: config.hypersync.apiToken,
      contracts: config.contracts,
      maximumPages: 256,
    });
    const started = performance.now();
    const logs = [];
    for (let from = config.deploymentBlock; from <= cursorBlock; from += CHUNK_BLOCKS) {
      const to = from + CHUNK_BLOCKS - 1n < cursorBlock ? from + CHUNK_BLOCKS - 1n : cursorBlock;
      logs.push(...(await client.getLogs(from, to)));
    }
    const scanMilliseconds = Math.round(performance.now() - started);
    const fromHyperSync = new Map<string, string>();
    for (const log of sortChainLogs(logs)) {
      const transition = decodeIndexedTransition({
        log,
        chainId: BigInt(config.chainId),
        eventId: config.eventId,
        contracts: config.contracts,
      });
      if (!transition) continue;
      fromHyperSync.set(
        transition.transitionId,
        [
          transition.kind,
          transition.blockNumber,
          transition.blockHash,
          transition.transactionHash,
          transition.logIndex,
        ]
          .join("|")
          .toLowerCase(),
      );
    }

    const stored = await pool.query<{
      transition_id: string;
      transition_kind: string;
      block_number: string;
      block_hash: string;
      transaction_hash: string;
      log_index: number;
    }>(
      `SELECT transition_id, transition_kind, block_number, block_hash, transaction_hash, log_index
         FROM finalized_chain_logs WHERE stream_id=$1 AND block_number <= $2`,
      [config.streamId, cursorBlock.toString()],
    );
    const fromIndexer = new Map(
      stored.rows.map((row) => [
        row.transition_id,
        [row.transition_kind, row.block_number, row.block_hash, row.transaction_hash, row.log_index]
          .join("|")
          .toLowerCase(),
      ]),
    );

    const missingFromHyperSync = [...fromIndexer.keys()].filter((id) => !fromHyperSync.has(id));
    const missingFromIndexer = [...fromHyperSync.keys()].filter((id) => !fromIndexer.has(id));
    const different = [...fromIndexer].filter(
      ([id, value]) => fromHyperSync.has(id) && fromHyperSync.get(id) !== value,
    );
    const result = {
      streamId: config.streamId,
      fromBlock: config.deploymentBlock.toString(),
      toBlock: cursorBlock.toString(),
      blocksScanned: (cursorBlock - config.deploymentBlock + 1n).toString(),
      hypersyncScanMilliseconds: scanMilliseconds,
      hypersyncLogs: logs.length,
      hypersyncTransitions: fromHyperSync.size,
      indexedTransitions: fromIndexer.size,
      missingFromHyperSync,
      missingFromIndexer,
      different: different.map(([id]) => id),
      parity:
        missingFromHyperSync.length === 0 &&
        missingFromIndexer.length === 0 &&
        different.length === 0,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.parity) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "HyperSync parity check failed"}\n`,
  );
  process.exitCode = 1;
});
