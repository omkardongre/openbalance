import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ForgeArtifact = { abi: readonly unknown[]; bytecode: `0x${string}` };

const artifactsRoot = new URL("../../../contracts/out/", import.meta.url);

/**
 * Loads a compiled Foundry artifact. Contracts must be built (`forge build`) before a local
 * scenario runs; a missing or bytecode-less artifact fails loudly rather than deploying nothing.
 */
export function loadArtifact(source: string, name: string): ForgeArtifact {
  const path = fileURLToPath(new URL(`${source}/${name}.json`, artifactsRoot));
  let parsed: { abi?: unknown; bytecode?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { abi?: unknown; bytecode?: unknown };
  } catch {
    throw new Error(`Contract artifact ${source}/${name}.json is unavailable; run forge build`);
  }
  // Foundry emits bytecode either as a hex string or as an object with an `object` field.
  const bytecode =
    typeof parsed.bytecode === "string"
      ? parsed.bytecode
      : parsed.bytecode && typeof parsed.bytecode === "object"
        ? (parsed.bytecode as { object?: unknown }).object
        : undefined;
  if (!Array.isArray(parsed.abi) || typeof bytecode !== "string" || !bytecode.startsWith("0x"))
    throw new Error(`Contract artifact ${source}/${name}.json has no deployable bytecode`);
  return { abi: parsed.abi, bytecode: bytecode as `0x${string}` };
}
