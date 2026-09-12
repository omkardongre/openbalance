import { z } from "zod";

const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const databaseSchema = z.object({ DATABASE_URL: z.string().min(1) }).passthrough();
const schema = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_002),
    DATABASE_URL: z.string().min(1),
    WEBAUTHN_RP_ID: z.string().min(1),
    WEBAUTHN_ORIGIN: z.string().url(),
    ACCOUNT_MANIFEST_PATH: z.string().min(1),
    ACCOUNT_RPC_URL: z.string().url(),
    SPONSOR_PRIVATE_KEY_PATH: z.string().min(1),
    SPONSOR_DAILY_DEPLOYMENTS: z.coerce.number().int().min(1).max(10_000),
    SPONSOR_MAX_DEPLOYMENT_GAS: positiveInteger,
    SPONSOR_MAX_FEE_PER_GAS_WEI: positiveInteger,
    SPONSOR_MAX_COST_WEI: positiveInteger,
  })
  .strict();

export function loadRelayerEnvironment(environment: NodeJS.ProcessEnv) {
  return schema.parse(environment);
}

export function loadRelayerDatabaseConfig(environment: NodeJS.ProcessEnv) {
  return { databaseUrl: databaseSchema.parse(environment).DATABASE_URL };
}
