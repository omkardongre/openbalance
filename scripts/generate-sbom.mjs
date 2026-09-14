import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const _root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output) {
  process.stderr.write("Usage: node scripts/generate-sbom.mjs <output.cdx.json>\n");
  process.exitCode = 64;
} else {
  const lockBytes = await readFile(new URL("../pnpm-lock.yaml", import.meta.url));
  const documents = parseAllDocuments(String(lockBytes));
  for (const document of documents) {
    if (document.errors.length) throw document.errors[0];
  }
  const packages = Object.assign(
    {},
    ...documents.map((document) => document.toJSON().packages ?? {}),
  );
  const components = [];
  for (const [key, value] of Object.entries(packages)) {
    const match = key.match(/^(@?[^@]+(?:\/[^@]+)?)@(.+)$/);
    if (!match) continue;
    const [, name, version] = match;
    const integrity = value.resolution?.integrity;
    const sha512 = integrity?.startsWith("sha512-")
      ? Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex")
      : undefined;
    components.push({
      type: "library",
      "bom-ref": `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
      name,
      version,
      purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
      ...(sha512
        ? {
            hashes: [{ alg: "SHA-512", content: sha512 }],
          }
        : {}),
    });
  }
  components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const document = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "application", name: "openbalance", version: "0.0.0" },
    },
    components,
    properties: [
      {
        name: "openbalance:pnpm-lock-sha256",
        value: createHash("sha256").update(lockBytes).digest("hex"),
      },
    ],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: "w" });
  process.stdout.write(`${JSON.stringify({ components: components.length, output })}\n`);
}
