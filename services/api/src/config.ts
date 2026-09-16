import { z } from "zod";

const environmentSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  DATABASE_URL: z.string().min(1).optional(),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_ORIGIN: z.string().url().optional(),
  ACCOUNT_MANIFEST_PATH: z.string().min(1).optional(),
  ACCOUNT_RPC_URL: z.string().url().optional(),
  PROJECTION_READS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CHECKOUT_MANIFEST_PATH: z.string().min(1).optional(),
  CHECKOUT_CAPABILITY_KEY_PATH: z.string().min(1).optional(),
  FAUCET_RPC_URL: z.string().url().optional(),
  FAUCET_CHAIN_ID: z.coerce.number().int().positive().optional(),
  FAUCET_CHAIN_NAME: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)
    .optional(),
  FAUCET_TOKEN_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  FAUCET_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(36).optional(),
  FAUCET_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  FAUCET_MAX_AMOUNT: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
  FAUCET_DAILY_LIMIT: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .optional(),
});

export function loadEnvironment(environment: NodeJS.ProcessEnv) {
  const parsed = environmentSchema.parse(environment);
  if (
    Boolean(parsed.ACCOUNT_MANIFEST_PATH) !== Boolean(parsed.ACCOUNT_RPC_URL) ||
    (parsed.ACCOUNT_MANIFEST_PATH && !parsed.DATABASE_URL)
  )
    throw new Error("Account deployment requires a manifest, RPC URL, and enrollment database");
  const count = [parsed.DATABASE_URL, parsed.WEBAUTHN_RP_ID, parsed.WEBAUTHN_ORIGIN].filter(
    Boolean,
  ).length;
  if (count !== 0 && count !== 3)
    throw new Error(
      "Enrollment requires DATABASE_URL, WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN together",
    );
  if (parsed.PROJECTION_READS_ENABLED && count !== 3)
    throw new Error("Projection reads require enrollment database and passkey configuration");
  if (
    Boolean(parsed.CHECKOUT_MANIFEST_PATH) !== Boolean(parsed.CHECKOUT_CAPABILITY_KEY_PATH) ||
    (parsed.CHECKOUT_MANIFEST_PATH &&
      (!parsed.DATABASE_URL || !parsed.ACCOUNT_RPC_URL || !parsed.PROJECTION_READS_ENABLED))
  )
    throw new Error(
      "Checkout requires a manifest, capability key, database, RPC URL, and projection reads",
    );
  const faucet = [
    parsed.FAUCET_RPC_URL,
    parsed.FAUCET_CHAIN_ID,
    parsed.FAUCET_CHAIN_NAME,
    parsed.FAUCET_TOKEN_ADDRESS,
    parsed.FAUCET_TOKEN_DECIMALS,
    parsed.FAUCET_PRIVATE_KEY_PATH,
    parsed.FAUCET_MAX_AMOUNT,
    parsed.FAUCET_DAILY_LIMIT,
  ];
  if (faucet.some(Boolean) && (faucet.some((value) => !value) || !parsed.DATABASE_URL))
    throw new Error("Faucet configuration must be complete and include the database");
  return parsed;
}
