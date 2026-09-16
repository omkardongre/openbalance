import { readFile } from "node:fs/promises";

/** Loads a 32-byte relay encryption key from raw bytes or 64 hex characters. */
export async function loadRelayKey(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 32) return Buffer.from(bytes);
  const text = bytes.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  throw new Error("Venue relay key file must contain exactly 32 raw bytes or 64 hex characters");
}
