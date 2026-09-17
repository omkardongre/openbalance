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
    INDEXER_BATCH_SIZE: positiveInteger.max(2_000).default(500),
    INDEXER_POLL_INTERVAL_MS: positiveInteger.min(250).max(60_000).default(2_000),
    INDEXER_DATABASE_POOL_SIZE: positiveInteger.max(20).default(5),
    INDEXER_PROVISIONAL_ENABLED: z.enum(["true", "false"]).default("false"),
    INDEXER_PROVISIONAL_REORG_DEPTH: positiveInteger.max(512).default(128),
    INDEXER_FINALITY_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
    INDEXER_ENVIRONMENT: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
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
  pollIntervalMilliseconds: number;
  databasePoolSize: number;
  environment: string;
  streamId: string;
  provisionalEnabled: boolean;
  provisionalReorgDepth: number;
  finalityTag: "finalized" | "safe" | "latest";
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
  return {
    databaseUrl: parsed.INDEXER_DATABASE_URL,
    rpcUrl: parsed.INDEXER_RPC_URL,
    chainId: parsed.INDEXER_CHAIN_ID,
    chainName: parsed.INDEXER_CHAIN_NAME,
    eventId: parsed.INDEXER_EVENT_ID,
    contracts,
    deploymentBlock: parsed.INDEXER_DEPLOYMENT_BLOCK,
    batchSize: parsed.INDEXER_BATCH_SIZE,
    pollIntervalMilliseconds: parsed.INDEXER_POLL_INTERVAL_MS,
    databasePoolSize: parsed.INDEXER_DATABASE_POOL_SIZE,
    environment: parsed.INDEXER_ENVIRONMENT,
    streamId: `${parsed.INDEXER_ENVIRONMENT}:${parsed.INDEXER_CHAIN_ID}:${parsed.INDEXER_EVENT_ID.toLowerCase()}`,
    provisionalEnabled: parsed.INDEXER_PROVISIONAL_ENABLED === "true",
    provisionalReorgDepth: parsed.INDEXER_PROVISIONAL_REORG_DEPTH,
    finalityTag: parsed.INDEXER_FINALITY_TAG,
  };
}
