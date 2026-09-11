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

export function loadVenueRelayEnvironment(environment: NodeJS.ProcessEnv) {
  return schema.parse(environment);
}
