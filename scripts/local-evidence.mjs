import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageEvidence } from "./package-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const verificationPath = process.argv[2] ?? "evidence/local-verification.json";
const sbomPath = "evidence/sbom.cdx.json";
const sloPath = "evidence/slo-observations.json";
const manifestPath = "evidence/local-evidence-manifest.json";
const bundleDirectory = "evidence/bundle";

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function exists(path) {
  try {
    await stat(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(verificationPath))) {
  process.stderr.write(`Missing ${verificationPath}. Run: pnpm verify:local ${verificationPath}\n`);
  process.exitCode = 64;
} else {
  if (!(await exists(sbomPath))) await run("node", ["scripts/generate-sbom.mjs", sbomPath]);
  await mkdir(resolve(root, "evidence"), { recursive: true });
  const artifacts = [
    { kind: "verification", path: verificationPath },
    { kind: "sbom", path: sbomPath },
  ];
  if (await exists(sloPath)) artifacts.push({ kind: "workload", path: sloPath });
  await writeFile(
    resolve(root, manifestPath),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        environment: "local",
        artifacts,
        limitations: [
          "This bundle records local verification only; it is not public-network or device proof.",
          "Every artifact is checksummed; no credentials or key material are included.",
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rm(resolve(root, bundleDirectory), { recursive: true, force: true });
  const index = await packageEvidence({
    manifestPath,
    outputDirectory: bundleDirectory,
    repositoryRoot: root,
  });
  process.stdout.write(
    `${JSON.stringify({ bundle: bundleDirectory, artifacts: index.artifacts.length })}\n`,
  );
}
