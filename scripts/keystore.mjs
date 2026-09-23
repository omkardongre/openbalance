// Web3 Secret Storage (keystore v3) decryption.
//
// The repository's signing convention is an encrypted keystore plus a password file, and every
// Foundry-driven script honours it by passing `--keystore`/`--password-file` straight to `cast`.
// The contention harness cannot: it signs through viem inside the scenario package, which needs the
// raw key. Decrypting here, in the parent process, keeps the plaintext key out of the shell, out of
// the user's history, and out of this process's own exported environment; it is handed only to the
// scenario child's environment.
//
// keccak256 is injected because the toolchain has no JavaScript keccak available at this layer
// (root scripts shell out to `cast keccak`), and injection keeps this module testable on its own.

import { createDecipheriv, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";

const HEX = /^(0x)?[0-9a-fA-F]*$/;

function fromHex(value, field) {
  if (typeof value !== "string" || !HEX.test(value) || value.replace(/^0x/, "").length % 2 !== 0)
    throw new Error(`Keystore field ${field} is not valid hex`);
  return Buffer.from(value.replace(/^0x/, ""), "hex");
}

/**
 * Decrypt a v3 scrypt keystore and return the private key as a 0x-prefixed hex string.
 *
 * @param {object} options
 * @param {string} options.keystorePath
 * @param {string} options.passwordPath
 * @param {(hex: string) => Promise<string>} options.keccak256 Hex in, 0x-prefixed digest out.
 */
export async function decryptKeystore({ keystorePath, passwordPath, keccak256 }) {
  const [rawKeystore, rawPassword] = await Promise.all([
    readFile(keystorePath, "utf8"),
    readFile(passwordPath, "utf8"),
  ]);

  let keystore;
  try {
    keystore = JSON.parse(rawKeystore);
  } catch {
    throw new Error(`Keystore ${keystorePath} is not JSON`);
  }
  if (keystore?.version !== 3) throw new Error("Only keystore version 3 is supported");

  const crypto = keystore.crypto ?? keystore.Crypto;
  if (!crypto) throw new Error("Keystore has no crypto section");
  if (crypto.kdf !== "scrypt") throw new Error(`Unsupported keystore kdf ${crypto.kdf}`);
  if (crypto.cipher !== "aes-128-ctr")
    throw new Error(`Unsupported keystore cipher ${crypto.cipher}`);

  const { dklen, n, r, p, salt } = crypto.kdfparams ?? {};
  if (![dklen, n, r, p].every((value) => Number.isInteger(value) && value > 0))
    throw new Error("Keystore kdfparams are incomplete");
  if (dklen < 32) throw new Error("Keystore derived key is too short");

  // The password file is written by a shell redirect, so a trailing newline is expected and is not
  // part of the secret. Only that terminator is stripped: interior whitespace is significant.
  const password = rawPassword.replace(/\r?\n$/, "");

  const derived = scryptSync(
    Buffer.from(password, "utf8"),
    fromHex(salt, "kdfparams.salt"),
    dklen,
    {
      N: n,
      r,
      p,
      // scrypt at N=8192,r=8 needs ~8 MiB; Node's default ceiling is 32 MiB, so raise it only as far
      // as the parameters actually declare rather than accepting an unbounded allocation.
      maxmem: 2 * 128 * n * r,
    },
  );
  const ciphertext = fromHex(crypto.ciphertext, "ciphertext");

  const mac = await keccak256(
    `0x${Buffer.concat([derived.subarray(16, 32), ciphertext]).toString("hex")}`,
  );
  if (
    typeof mac !== "string" ||
    mac.replace(/^0x/, "").toLowerCase() !== String(crypto.mac).replace(/^0x/, "").toLowerCase()
  )
    throw new Error("Keystore password is incorrect (MAC mismatch)");

  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    fromHex(crypto.cipherparams?.iv, "cipherparams.iv"),
  );
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (privateKey.length !== 32) throw new Error("Decrypted keystore is not a 32-byte private key");
  return `0x${privateKey.toString("hex")}`;
}
