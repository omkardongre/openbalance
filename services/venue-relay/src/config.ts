import { configurationView } from "@openbalance/observability";
import { getAddress } from "viem";
import { z } from "zod";

const schema = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_003),
    VENUE_RELAY_DATABASE_PATH: z.string().min(1),
    VENUE_RELAY_KEY_PATH: z.string().min(1),
    TERMINAL_SNAPSHOT_PATH: z.string().min(1),
    TERMINAL_INGRESS_AUDIENCE: z.string().url(),
    TERMINAL_MAXIMUM_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(1).max(900).default(120),
  })
  .strict();

const CONFIGURATION_PREFIXES = ["VENUE_RELAY_", "TERMINAL_"];

export function loadVenueRelayEnvironment(environment: NodeJS.ProcessEnv) {
  return schema.parse(
    configurationView(
      environment,
      Object.keys(schema.shape),
      CONFIGURATION_PREFIXES,
      "venue relay",
    ),
  );
}

const settlementSchema = z
  .object({
    VENUE_RELAY_DATABASE_PATH: z.string().min(1),
    VENUE_RELAY_KEY_PATH: z.string().min(1),
    VENUE_RELAY_RPC_URL: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
        );
      }),
    VENUE_RELAY_CHAIN_ID: z.coerce.number().int().safe().positive(),
    VENUE_RELAY_CHAIN_NAME: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
    VENUE_RELAY_VAULT_ADDRESS: z.string().transform((value, context) => {
      try {
        return getAddress(value);
      } catch {
        context.addIssue({ code: "custom", message: "invalid vault address" });
        return z.NEVER;
      }
    }),
    VENUE_RELAY_DEPLOYMENT_BLOCK: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .transform(BigInt),
    VENUE_RELAY_FINALITY_TAG: z.enum(["finalized", "safe", "latest"]).default("finalized"),
    VENUE_RELAY_SETTLEMENT_PRIVATE_KEY_PATH: z.string().min(1),
    VENUE_RELAY_SETTLEMENT_WORKER_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/),
    VENUE_RELAY_SETTLEMENT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    VENUE_RELAY_SETTLEMENT_POLL_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
    VENUE_RELAY_SETTLEMENT_LEASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .passthrough();

export type VenueRelaySettlementConfig = z.infer<typeof settlementSchema>;

export function loadVenueRelaySettlementEnvironment(
  environment: NodeJS.ProcessEnv,
): VenueRelaySettlementConfig {
  return settlementSchema.parse(environment);
}
