import { readFile } from "node:fs/promises";
import type { Hex } from "viem";
import { z } from "zod";
import type { IntegrationMapping } from "./source.js";

const environmentSchema = z
  .object({
    INTEGRATION_DATABASE_URL: z.string().min(1),
    INDEXER_DATABASE_URL: z.string().min(1),
    API_DATABASE_URL: z.string().min(1),
    INTEGRATION_MAPPING_PATH: z.string().min(1),
    ERPNEXT_BASE_URL: z.string().url(),
    ERPNEXT_API_KEY: z.string().min(8),
    ERPNEXT_API_SECRET: z.string().min(16),
    ERPNEXT_METHOD: z.string().min(1).optional(),
    INTEGRATION_WORKER_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/)
      .default(`integration:${process.pid}`),
    INTEGRATION_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
    INTEGRATION_IMPORT_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
    INTEGRATION_DELIVERY_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
  })
  .passthrough();

const mappingSchema = z
  .object({
    schemaVersion: z.literal(1),
    mappings: z
      .array(
        z
          .object({
            streamId: z.string().min(3).max(255),
            eventId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            vendorId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
            company: z.string().min(1).max(140),
            assetCode: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

export function loadIntegrationEnvironment(environment: NodeJS.ProcessEnv) {
  return environmentSchema.parse(environment);
}

export async function loadIntegrationMappings(path: string): Promise<IntegrationMapping[]> {
  const parsed = mappingSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const mappings = parsed.mappings.map((mapping) => ({
    ...mapping,
    eventId: mapping.eventId.toLowerCase() as Hex,
    vendorId: mapping.vendorId.toLowerCase() as Hex,
  }));
  const identities = mappings.map(
    (mapping) => `${mapping.streamId}:${mapping.eventId}:${mapping.vendorId}`,
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("Integration mapping contains a duplicate event vendor");
  return mappings;
}
