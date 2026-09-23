import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { decryptKeystore } from "./keystore.mjs";

const run = promisify(execFile);
const cast = (args) => run("cast", args).then(({ stdout }) => stdout.trim());
const keccak256 = (hex) => cast(["keccak", hex]);

// A throwaway key generated for this test only; it holds nothing and is never used off-test.
const PRIVATE_KEY = `0x${"11".repeat(31)}22`;
const PASSWORD = "correct horse battery staple";

let dir;
let keystorePath;
let passwordPath;
let expectedAddress;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "openbalance-keystore-"));
  passwordPath = join(dir, "password");
  // Trailing newline on purpose: this is how a shell redirect writes a password file, and the
  // decryptor must tolerate it the same way `cast --password-file` does.
  await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
  await run("cast", [
    "wallet",
    "import",
    "deployer",
    "--keystore-dir",
    dir,
    "--private-key",
    PRIVATE_KEY,
    "--unsafe-password",
    PASSWORD,
  ]);
  keystorePath = join(dir, "deployer");
  expectedAddress = await cast(["wallet", "address", "--private-key", PRIVATE_KEY]);
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("recovers the private key a keystore was created from", async () => {
  const recovered = await decryptKeystore({ keystorePath, passwordPath, keccak256 });
  assert.equal(recovered, PRIVATE_KEY);
  assert.equal(await cast(["wallet", "address", "--private-key", recovered]), expectedAddress);
});

test("rejects a wrong password instead of returning a wrong key", async () => {
  const wrongPath = join(dir, "wrong-password");
  await writeFile(wrongPath, "not the password\n", { mode: 0o600 });
  await assert.rejects(
    decryptKeystore({ keystorePath, passwordPath: wrongPath, keccak256 }),
    /MAC mismatch/,
  );
});
