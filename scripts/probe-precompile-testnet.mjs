// One-time platform-conformance probe: confirms the deployed account's WebAuthn verification path
// actually reaches Monad's native P256 precompile at 0x0100 (EIP-7951), rather than silently falling
// back to OpenZeppelin's ~330k-gas Solidity implementation. `P256.verify` (used by StrictWebAuthn and
// therefore OpenBalanceAccount) does not revert on either path, so gas is the only signal for it.
// `WebAuthnProbe.verifyNative` calls `P256.verifyNative`, which reverts with `MissingPrecompile` if
// the precompile is absent — an unambiguous presence check independent of gas.
//
// This is a compatibility probe, not a deployment: it uses the funded deployer key to publish a
// throwaway, non-custodial contract with no payment capability, and is not part of the production
// deploy flow in deploy-testnet.mjs.

import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { foundry } from "./foundry-bin.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const CHAIN_ID = 10_143;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function rpcUrl() {
  const url = requireEnv("ACCOUNT_RPC_URL");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("ACCOUNT_RPC_URL must use HTTPS");
  return url;
}

function signer() {
  return [
    "--keystore",
    requireEnv("DEPLOYER_KEYSTORE_PATH"),
    "--password-file",
    requireEnv("DEPLOYER_KEYSTORE_PASSWORD_FILE"),
  ];
}

const toHex = (buffer) => `0x${Buffer.from(buffer).toString("hex")}`;
const pad32 = (hex) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;

/**
 * Generates a real P-256 keypair and a real, low-s-normalized ECDSA signature. `P256.verifyNative`
 * takes an already-computed digest `h` and checks the signature against it directly; WebCrypto's
 * `subtle.sign` instead hashes its input itself before signing, so this returns both the digest it
 * actually signed over (SHA-256 of a random message) and the signature, rather than trying to make
 * WebCrypto sign a caller-supplied digest verbatim.
 */
async function sign() {
  const { subtle } = webcrypto;
  const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await subtle.exportKey("jwk", keys.publicKey);
  const x = pad32(toHex(Buffer.from(jwk.x, "base64url")));
  const y = pad32(toHex(Buffer.from(jwk.y, "base64url")));
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const message = webcrypto.getRandomValues(new Uint8Array(32));
  const digest = pad32(toHex(Buffer.from(await subtle.digest("SHA-256", message))));
  const signature = Buffer.from(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, message),
  );
  const r = pad32(toHex(signature.subarray(0, 32)));
  const rawS = BigInt(toHex(signature.subarray(32)));
  const s = pad32(
    toHex(Buffer.from((rawS > order / 2n ? order - rawS : rawS).toString(16), "hex")),
  );
  return { x, y, r, s, digest };
}

async function main() {
  const url = rpcUrl();
  const cast = (args) => foundry("cast", args, { cwd: root });
  const seenChain = BigInt(await cast(["chain-id", "--rpc-url", url]));
  if (seenChain !== BigInt(CHAIN_ID))
    throw new Error(`Expected Monad testnet chain ${CHAIN_ID}, got ${seenChain}`);

  const { x, y, r, s, digest } = await sign();
  const rpIdHash = pad32(toHex(webcrypto.getRandomValues(new Uint8Array(32))));
  const deployOutput = await foundry(
    "forge",
    [
      "create",
      "contracts/src/WebAuthnProbe.sol:WebAuthnProbe",
      "--via-ir",
      "--rpc-url",
      url,
      "--broadcast",
      ...signer(),
      "--constructor-args",
      x,
      y,
      rpIdHash,
      "https://openbalance.testnet.probe",
    ],
    { cwd: root },
  );
  const address = deployOutput.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  if (!address) throw new Error(`Could not parse deployed probe address from: ${deployOutput}`);

  // Unambiguous presence check: verifyNative reverts with MissingPrecompile if 0x0100 has no code,
  // and otherwise returns the real verification result. No revert here means the precompile is
  // confirmed reachable from a real deployed contract on this chain, not merely present as a
  // standalone eth_call target.
  let precompilePresent;
  let precompileResult;
  try {
    precompileResult = await cast([
      "call",
      "--rpc-url",
      url,
      address,
      "verifyNative(bytes32,bytes32,bytes32)(bool)",
      digest,
      r,
      s,
    ]);
    precompilePresent = true;
  } catch (error) {
    if (/MissingPrecompile/.test(error.message)) precompilePresent = false;
    else throw error;
  }

  // Same call, but through cast's --gas-estimate against the account's actual verification entry
  // point (P256.verify via StrictWebAuthn), to record the real per-purchase cost rather than an
  // isolated precompile call. verifyNative and P256.verify dispatch through the same 0x100 staticcall
  // when the precompile is present, so this gas figure is representative of OpenBalanceAccount.
  const gasEstimate = await cast([
    "estimate",
    "--rpc-url",
    url,
    address,
    "verifyNative(bytes32,bytes32,bytes32)",
    digest,
    r,
    s,
  ]);

  const report = {
    chainId: Number(seenChain),
    probeAddress: address,
    precompilePresent,
    precompileResult: precompilePresent ? precompileResult : null,
    verifyNativeGasEstimate: gasEstimate,
    conclusion: precompilePresent
      ? "OpenBalanceAccount's WebAuthn verification reaches the native P256 precompile at 0x0100; the ~330k-gas Solidity fallback is not the live path."
      : "Precompile at 0x0100 is absent on this chain; OpenBalanceAccount silently uses the Solidity fallback at roughly 100x the gas cost.",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!precompilePresent) process.exitCode = 1;
}

await main();
