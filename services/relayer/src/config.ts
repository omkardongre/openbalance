import { configurationView } from "@openbalance/observability";
import { z } from "zod";

const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const databaseSchema = z.object({ DATABASE_URL: z.string().min(1) }).passthrough();
const workerSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    FINANCIAL_EVENT_MANIFEST_PATH: z.string().min(1),
    FINANCIAL_RPC_URL: z.string().url(),
    FINANCIAL_CHAIN_NAME: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
    FINANCIAL_SIGNER_PRIVATE_KEY_PATH: z.string().min(1),
    // Additional signing keys, comma separated. Sponsored throughput is bounded per key by the
    // chain's inflight gas budget (see FINANCIAL_RESERVE_BALANCE_WEI), so raising concurrency means
    // adding keys rather than raising a limit. Each key keeps its own nonce sequence and budget.
    FINANCIAL_SIGNER_ADDITIONAL_KEY_PATHS: z.string().optional(),
    FINANCIAL_WORKER_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/),
    FINANCIAL_FINALITY_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
    FINANCIAL_MAX_GAS: positiveInteger,
    FINANCIAL_MAX_FEE_PER_GAS_WEI: positiveInteger,
    FINANCIAL_MAX_COST_WEI: positiveInteger,
    // Gas is charged on the declared limit with no refund, so a margin over the estimate is a
    // permanent overspend and also consumes inflight budget the transaction never uses. This is
    // deliberately a small margin to absorb state-dependent variation, not an Ethereum-style buffer.
    FINANCIAL_GAS_LIMIT_MARGIN_BPS: z.coerce.number().int().min(0).max(5_000).default(1_000),
    // Per-account ceiling on the summed gas spend of all inflight transactions. Exceeding it makes
    // consensus exclude the transaction silently rather than include and revert it, so the worker
    // must account for it before signing. Defaults to the documented 10 MON; 0 disables the check
    // for development chains that do not implement the rule.
    FINANCIAL_RESERVE_BALANCE_WEI: z
      .string()
      .regex(/^[0-9]+$/)
      .default("10000000000000000000"),
    FINANCIAL_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    FINANCIAL_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    FINANCIAL_RETRY_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(15_000),
    FINANCIAL_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  })
  .passthrough();
const schema = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_002),
    DATABASE_URL: z.string().min(1),
    WEBAUTHN_RP_ID: z.string().min(1),
    WEBAUTHN_ORIGIN: z.string().url(),
    ACCOUNT_MANIFEST_PATH: z.string().min(1),
    ACCOUNT_RPC_URL: z.string().url(),
    ACCOUNT_FINALITY_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
    SPONSOR_PRIVATE_KEY_PATH: z.string().min(1),
    SPONSOR_DAILY_DEPLOYMENTS: z.coerce.number().int().min(1).max(10_000),
    SPONSOR_MAX_DEPLOYMENT_GAS: positiveInteger,
    SPONSOR_MAX_FEE_PER_GAS_WEI: positiveInteger,
    SPONSOR_MAX_COST_WEI: positiveInteger,
    FINANCIAL_EVENT_MANIFEST_PATH: z.string().min(1).optional(),
    FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS: positiveInteger.default("3600"),
  })
  .strict();

const CONFIGURATION_PREFIXES = ["ACCOUNT_", "DATABASE_", "FINANCIAL_", "SPONSOR_", "WEBAUTHN_"];

export function loadRelayerEnvironment(environment: NodeJS.ProcessEnv) {
  const parsed = schema.parse(
    configurationView(environment, Object.keys(schema.shape), CONFIGURATION_PREFIXES, "relayer"),
  );
  if (BigInt(parsed.FINANCIAL_COMMAND_MAX_LIFETIME_SECONDS) > 86_400n)
    throw new Error("Financial command lifetime exceeds one day");
  return parsed;
}

export function loadRelayerDatabaseConfig(environment: NodeJS.ProcessEnv) {
  return { databaseUrl: databaseSchema.parse(environment).DATABASE_URL };
}

export function loadFinancialWorkerEnvironment(environment: NodeJS.ProcessEnv) {
  return workerSchema.parse(environment);
}
