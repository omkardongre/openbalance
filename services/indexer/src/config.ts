import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import type { IndexedContracts } from "./types.js";

const address = z.string().transform((value, context) => {
  try {
    return getAddress(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid address" });
    return z.NEVER;
  }
});
const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);
const positiveInteger = z.coerce.number().int().safe().positive();
export const MAXIMUM_RPC_BATCH = 2_000;
export const MAXIMUM_HYPERSYNC_BATCH = 1_000_000;
const nonnegativeBigInt = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(BigInt)
  .refine((value) => value <= 9_223_372_036_854_775_807n, "block exceeds PostgreSQL bigint");

const databaseSchema = z.object({
  INDEXER_DATABASE_URL: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    }),
});

const schema = z
  .object({
    INDEXER_DATABASE_URL: databaseSchema.shape.INDEXER_DATABASE_URL,
    INDEXER_RPC_URL: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
        );
      }),
    INDEXER_CHAIN_ID: positiveInteger,
    INDEXER_CHAIN_NAME: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
    INDEXER_EVENT_ID: hex32,
    INDEXER_ROUTER_ADDRESS: address,
    INDEXER_LEDGER_ADDRESS: address,
    INDEXER_VAULT_ADDRESS: address,
    INDEXER_DEPLOYMENT_BLOCK: nonnegativeBigInt,
    // Blocks per committed batch. RPC providers cap eth_getLogs ranges, so 2,000 is the RPC ceiling;
    // HyperSync has no such cap, which is what makes backfill fast (checked in `loadIndexerConfig`).
    INDEXER_BATCH_SIZE: positiveInteger.max(MAXIMUM_HYPERSYNC_BATCH).optional(),
    // Range for eth_getLogs when HyperSync is off or a HyperSync batch falls back to the RPC.
    INDEXER_RPC_LOG_RANGE: positiveInteger.max(MAXIMUM_RPC_BATCH).default(500),
    INDEXER_POLL_INTERVAL_MS: positiveInteger.min(250).max(60_000).optional(),
    INDEXER_DATABASE_POOL_SIZE: positiveInteger.max(20).default(5),
    INDEXER_PROVISIONAL_ENABLED: z.enum(["true", "false"]).default("false"),
    INDEXER_PROVISIONAL_REORG_DEPTH: positiveInteger.max(512).default(128),
    INDEXER_FINALITY_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
    INDEXER_ENVIRONMENT: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    // Envio HyperSync as the log source. Both or neither: a URL without a token would only 401.
    INDEXER_HYPERSYNC_URL: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:", "HyperSync URL must use HTTPS")
      .optional(),
    ENVIO_API_TOKEN: z.string().min(1).optional(),
    INDEXER_HYPERSYNC_TOKEN_PATH: z.string().min(1).optional(),
    INDEXER_HYPERSYNC_CATCH_UP_MS: positiveInteger.max(30_000).default(3_000),
  })
  .passthrough();

export type IndexerConfig = {
  databaseUrl: string;
  rpcUrl: string;
  chainId: number;
  chainName: string;
  eventId: Hex;
  contracts: IndexedContracts;
  deploymentBlock: bigint;
  batchSize: number;
  /** Largest block range sent to eth_getLogs. */
  rpcLogRange: number;
  pollIntervalMilliseconds: number;
  databasePoolSize: number;
  environment: string;
  streamId: string;
  provisionalEnabled: boolean;
  provisionalReorgDepth: number;
  finalityTag: "finalized" | "safe" | "latest";
  /** Present when HyperSync is the log source; absent means logs come from the RPC alone. */
  hypersync?: { url: string; apiToken: string; catchUpMilliseconds: number };
};

export function loadIndexerDatabaseConfig(environment: NodeJS.ProcessEnv): {
  databaseUrl: string;
} {
  const parsed = databaseSchema.parse(environment);
  return { databaseUrl: parsed.INDEXER_DATABASE_URL };
}

export function loadIndexerConfig(environment: NodeJS.ProcessEnv): IndexerConfig {
  const parsed = schema.parse(environment);
  const contracts = {
    router: parsed.INDEXER_ROUTER_ADDRESS,
    ledger: parsed.INDEXER_LEDGER_ADDRESS,
    vault: parsed.INDEXER_VAULT_ADDRESS,
  };
  const unique = new Set(Object.values(contracts).map((value) => value.toLowerCase()));
  if (
    unique.size !== 3 ||
    unique.has("0x0000000000000000000000000000000000000000") ||
    parsed.INDEXER_EVENT_ID.toLowerCase() === `0x${"00".repeat(32)}`
  )
    throw new Error("Indexer manifest contains an invalid identifier or contract address");
  // The token arrives as a mounted secret file in deployment and as ENVIO_API_TOKEN locally.
  if (parsed.ENVIO_API_TOKEN !== undefined && parsed.INDEXER_HYPERSYNC_TOKEN_PATH !== undefined)
    throw new Error("Set ENVIO_API_TOKEN or INDEXER_HYPERSYNC_TOKEN_PATH, not both");
  const apiToken =
    parsed.ENVIO_API_TOKEN ??
    (parsed.INDEXER_HYPERSYNC_TOKEN_PATH === undefined
      ? undefined
      : readFileSync(parsed.INDEXER_HYPERSYNC_TOKEN_PATH, "utf8").trim());
  if ((parsed.INDEXER_HYPERSYNC_URL === undefined) !== (apiToken === undefined))
    throw new Error("INDEXER_HYPERSYNC_URL and a HyperSync API token must be set together");
  if (apiToken === "") throw new Error("HyperSync API token file is empty");
  const hypersyncEnabled = parsed.INDEXER_HYPERSYNC_URL !== undefined;
  // HyperSync is billed per query, not per block, so backfill takes the widest batches it allows.
  const batchSize =
    parsed.INDEXER_BATCH_SIZE ??
    (hypersyncEnabled ? MAXIMUM_HYPERSYNC_BATCH : parsed.INDEXER_RPC_LOG_RANGE);
  // Once caught up, each poll costs one query. The free plan affords 15 a minute, so polling every
  // 5 seconds (12 a minute) stays inside it with room for a backfill page or a retry.
  const pollIntervalMilliseconds =
    parsed.INDEXER_POLL_INTERVAL_MS ?? (hypersyncEnabled ? 5_000 : 2_000);
  if (!hypersyncEnabled && batchSize > MAXIMUM_RPC_BATCH)
    throw new Error(`INDEXER_BATCH_SIZE above ${MAXIMUM_RPC_BATCH} needs HyperSync`);
  return {
    rpcLogRange: parsed.INDEXER_RPC_LOG_RANGE,
    ...(parsed.INDEXER_HYPERSYNC_URL && apiToken
      ? {
          hypersync: {
            url: parsed.INDEXER_HYPERSYNC_URL,
            apiToken,
            catchUpMilliseconds: parsed.INDEXER_HYPERSYNC_CATCH_UP_MS,
          },
        }
      : {}),
    databaseUrl: parsed.INDEXER_DATABASE_URL,
    rpcUrl: parsed.INDEXER_RPC_URL,
    chainId: parsed.INDEXER_CHAIN_ID,
    chainName: parsed.INDEXER_CHAIN_NAME,
    eventId: parsed.INDEXER_EVENT_ID,
    contracts,
    deploymentBlock: parsed.INDEXER_DEPLOYMENT_BLOCK,
    batchSize,
    pollIntervalMilliseconds,
    databasePoolSize: parsed.INDEXER_DATABASE_POOL_SIZE,
    environment: parsed.INDEXER_ENVIRONMENT,
    streamId: `${parsed.INDEXER_ENVIRONMENT}:${parsed.INDEXER_CHAIN_ID}:${parsed.INDEXER_EVENT_ID.toLowerCase()}`,
    provisionalEnabled: parsed.INDEXER_PROVISIONAL_ENABLED === "true",
    provisionalReorgDepth: parsed.INDEXER_PROVISIONAL_REORG_DEPTH,
    finalityTag: parsed.INDEXER_FINALITY_TAG,
  };
}
