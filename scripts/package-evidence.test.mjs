import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageEvidence } from "./package-evidence.mjs";

test("packages checksummed evidence and rejects credential-shaped fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbalance-evidence-"));
  await writeFile(join(root, "result.json"), '{"status":"FINALIZED"}\n');
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      environment: "local",
      chainId: 31337,
      commit: "dirty",
      artifacts: [{ kind: "result", path: "result.json" }],
    }),
  );
  const index = await packageEvidence({
    manifestPath: "manifest.json",
    outputDirectory: "bundle",
    repositoryRoot: root,
  });
  assert.equal(index.artifacts.length, 1);
  await writeFile(join(root, "result.json"), JSON.stringify({ accessToken: "unsafe" }));
  await assert.rejects(
    packageEvidence({
      manifestPath: "manifest.json",
      outputDirectory: "denied",
      repositoryRoot: root,
    }),
    /forbidden field/,
  );
  await symlink(tmpdir(), join(root, "escape"));
  await writeFile(
    join(root, "escape-manifest.json"),
    JSON.stringify({ schemaVersion: 1, artifacts: [{ kind: "result", path: "escape" }] }),
  );
  await assert.rejects(
    packageEvidence({
      manifestPath: "escape-manifest.json",
      outputDirectory: "denied",
      repositoryRoot: root,
    }),
    /unsafe/,
  );
  await mkdir(join(root, "second"));
  await writeFile(
    join(root, "secret.json"),
    JSON.stringify({ schemaVersion: 1, apiToken: "unsafe", artifacts: [] }),
  );
  await assert.rejects(
    packageEvidence({
      manifestPath: "secret.json",
      outputDirectory: "second/bundle",
      repositoryRoot: root,
    }),
    /forbidden field/,
  );
});
