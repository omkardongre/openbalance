import { Pool } from "pg";
import { defineChain } from "viem";
import { loadIndexerConfig } from "./config.js";
import { ProjectionRebuildService } from "./rebuild.js";
import { ViemFinalizedChainSource } from "./source.js";

async function main() {
  const config = loadIndexerConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const service = new ProjectionRebuildService(pool, config.databaseUrl);
    if (process.argv[2] === "promote") {
      const rebuildId = process.argv[3];
      const digest = process.argv[4];
      if (!rebuildId || !digest) throw new Error("Usage: rebuild promote REBUILD_ID PLAN_DIGEST");
      await service.promote(rebuildId, digest);
      process.stdout.write(`${JSON.stringify({ state: "PROMOTED", rebuildId })}\n`);
      return;
    }
    const requestedBy = process.env.INDEXER_REBUILD_OPERATOR;
    if (!requestedBy) throw new Error("INDEXER_REBUILD_OPERATOR is required");
    const source = new ViemFinalizedChainSource({
      rpcUrl: config.rpcUrl,
      contracts: config.contracts,
      chain: defineChain({
        id: config.chainId,
        name: config.chainName,
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: [config.rpcUrl] } },
      }),
    });
    const plan = await service.rebuild({
      streamId: config.streamId,
      chainId: BigInt(config.chainId),
      eventId: config.eventId,
      contracts: config.contracts,
      deploymentBlock: config.deploymentBlock,
      batchSize: config.batchSize,
      source,
      requestedBy,
    });
    process.stdout.write(
      `${JSON.stringify({ ...plan, targetBlock: plan.targetBlock.toString() })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", service: "projection-rebuild", message: error instanceof Error ? error.message : "Projection rebuild failed" })}\n`,
  );
  process.exitCode = 1;
});
