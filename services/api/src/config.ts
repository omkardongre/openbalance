import { z } from "zod";

const environmentSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  DATABASE_URL: z.string().min(1).optional(),
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_ORIGIN: z.string().url().optional(),
  ACCOUNT_MANIFEST_PATH: z.string().min(1).optional(),
  ACCOUNT_RPC_URL: z.string().url().optional(),
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
  return parsed;
}
