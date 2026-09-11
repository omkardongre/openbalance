import { readFile } from "node:fs/promises";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import type { TerminalDirectory, TerminalRegistration } from "./transport.js";

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    chainId: z.number().int().positive(),
    registry: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    finalizedBlockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
    finalizedBlockHash: hex32,
    generatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    terminals: z
      .array(
        z
          .object({
            terminalId: hex32,
            keyVersion: z.string().regex(/^[1-9][0-9]*$/),
            channelId: hex32,
            signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            enabled: z.boolean(),
            validAfter: z.number().int().nonnegative(),
            validUntil: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

type TerminalSnapshot = z.infer<typeof manifestSchema>;

export class InvalidTerminalSnapshot extends Error {}

function key(terminalId: string, keyVersion: bigint, channelId: string): string {
  return `${terminalId.toLowerCase()}:${keyVersion}:${channelId.toLowerCase()}`;
}

export class TerminalSnapshotDirectory implements TerminalDirectory {
  readonly #entries = new Map<string, TerminalRegistration>();
  readonly #expiresAt: number;
  readonly #now: () => number;

  constructor(snapshot: unknown, now: () => number = () => Math.floor(Date.now() / 1_000)) {
    const parsed = manifestSchema.safeParse(snapshot);
    if (!parsed.success) throw new InvalidTerminalSnapshot("Terminal snapshot is invalid");
    if (parsed.data.generatedAt >= parsed.data.expiresAt)
      throw new InvalidTerminalSnapshot("Terminal snapshot lifetime is invalid");
    this.#expiresAt = parsed.data.expiresAt;
    this.#now = now;
    for (const entry of parsed.data.terminals) {
      if (entry.validAfter >= entry.validUntil)
        throw new InvalidTerminalSnapshot("Terminal validity window is invalid");
      const entryKey = key(entry.terminalId, BigInt(entry.keyVersion), entry.channelId);
      if (this.#entries.has(entryKey))
        throw new InvalidTerminalSnapshot("Terminal snapshot contains duplicate scope");
      this.#entries.set(entryKey, {
        signer: getAddress(entry.signer),
        enabled: entry.enabled,
        validAfter: entry.validAfter,
        validUntil: entry.validUntil,
      });
    }
  }

  async resolve(input: {
    terminalId: Hex;
    keyVersion: bigint;
    channelId: Hex;
  }): Promise<TerminalRegistration | null> {
    if (this.#now() >= this.#expiresAt)
      throw new InvalidTerminalSnapshot("Terminal snapshot has expired");
    return this.#entries.get(key(input.terminalId, input.keyVersion, input.channelId)) ?? null;
  }
}

export async function loadTerminalSnapshotDirectory(
  path: string,
  now?: () => number,
): Promise<TerminalSnapshotDirectory> {
  let value: TerminalSnapshot;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as TerminalSnapshot;
  } catch {
    throw new InvalidTerminalSnapshot("Terminal snapshot cannot be read");
  }
  return new TerminalSnapshotDirectory(value, now);
}
