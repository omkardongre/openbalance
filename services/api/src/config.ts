import { z } from "zod";

const environmentSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
});

export function loadEnvironment(environment: NodeJS.ProcessEnv) {
  return environmentSchema.parse(environment);
}
