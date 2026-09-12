import { readFile } from "node:fs/promises";
import { getAddress } from "viem";
import { z } from "zod";
import type { FinancialEventCommandPolicy } from "./attendee-commands.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    chainId: z.number().int().positive().safe(),
    events: z
      .array(
        z
          .object({
            eventId: bytes32,
            router: address,
            vault: address,
            ledger: address,
            asset: address,
            deploymentBlock: z.string().regex(/^(0|[1-9][0-9]*)$/),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict();

export type FinancialEventManifest = {
  schemaVersion: 1;
  chainId: number;
  events: (FinancialEventCommandPolicy & { ledger: `0x${string}`; deploymentBlock: bigint })[];
};

export async function loadFinancialEventManifest(path: string): Promise<FinancialEventManifest> {
  const parsed = schema.parse(JSON.parse(await readFile(path, "utf8")));
  const events = parsed.events.map((event) => ({
    eventId: event.eventId.toLowerCase() as `0x${string}`,
    router: getAddress(event.router),
    vault: getAddress(event.vault),
    ledger: getAddress(event.ledger),
    asset: getAddress(event.asset),
    deploymentBlock: BigInt(event.deploymentBlock),
  }));
  if (new Set(events.map((event) => event.eventId)).size !== events.length)
    throw new Error("Financial event manifest contains duplicate event IDs");
  if (
    events.some(
      (event) =>
        event.eventId === `0x${"00".repeat(32)}` ||
        [event.router, event.vault, event.ledger, event.asset].some(
          (value) => value === "0x0000000000000000000000000000000000000000",
        ) ||
        new Set([event.router, event.vault, event.ledger]).size !== 3,
    )
  )
    throw new Error("Financial event manifest contains an invalid deployment");
  return { schemaVersion: 1, chainId: parsed.chainId, events };
}
