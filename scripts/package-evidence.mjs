import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

const HEX_32 = /^[a-f0-9]{64}$/;
const SECRET_NAME =
  /(secret|private[_-]?key|password|authorization|cookie|api[_-]?token|access[_-]?token|auth[_-]?token)/i;

export function assertSafeEvidence(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertSafeEvidence(item, `${path}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_NAME.test(key))
      throw new Error(`Evidence contains a forbidden field at ${path}.${key}`);
    assertSafeEvidence(child, `${path}.${key}`);
  }
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep);
}

export async function packageEvidence({
  manifestPath,
  outputDirectory,
  repositoryRoot = process.cwd(),
}) {
  const root = await realpath(resolve(repositoryRoot));
  const manifestFile = await realpath(resolve(root, manifestPath));
  const output = resolve(root, outputDirectory);
  if (!inside(root, manifestFile) || !inside(root, output))
    throw new Error("Evidence paths must remain inside the repository");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assertSafeEvidence(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  )
    throw new Error("Evidence manifest must contain versioned artifacts");

  const artifacts = [];
  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry.path !== "string" || typeof entry.kind !== "string")
      throw new Error("Invalid evidence artifact");
    const file = await realpath(resolve(root, entry.path));
    if (!inside(root, file) || inside(output, file))
      throw new Error("Evidence artifact path is unsafe");
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (entry.sha256 !== undefined && (!HEX_32.test(entry.sha256) || entry.sha256 !== sha256))
      throw new Error(`Evidence checksum mismatch for ${entry.path}`);
    if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(bytes.toString("utf8")))
      throw new Error(`Private key material detected in ${entry.path}`);
    if (file.endsWith(".json")) assertSafeEvidence(JSON.parse(bytes.toString("utf8")));
    artifacts.push({
      kind: entry.kind,
      path: relative(root, file),
      bytes: bytes.byteLength,
      sha256,
    });
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  await mkdir(output, { recursive: true });
  if (!inside(root, await realpath(output))) throw new Error("Evidence output escapes repository");
  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceManifest: basename(manifestFile),
    environment: manifest.environment,
    chainId: manifest.chainId,
    commit: manifest.commit,
    limitations: manifest.limitations ?? [],
    artifacts,
  };
  assertSafeEvidence(index);
  await writeFile(resolve(output, "index.json"), `${JSON.stringify(index, null, 2)}\n`, {
    flag: "wx",
  });
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifestPath = process.argv[2];
  const outputDirectory = process.argv[3];
  if (!manifestPath || !outputDirectory) {
    process.stderr.write(
      "Usage: node scripts/package-evidence.mjs <manifest.json> <output-directory>\n",
    );
    process.exitCode = 64;
  } else {
    packageEvidence({ manifestPath, outputDirectory }).then(
      (index) => process.stdout.write(`${JSON.stringify(index)}\n`),
      (error) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : "Evidence packaging failed"}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
