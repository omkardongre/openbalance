import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http, sha256, stringToHex, toHex } from "viem";

// Uses an unlocked local Anvil account only. Public-network mode performs read-only RPC calls.
const remote = process.argv.includes("--testnet");
const rpc = remote ? "https://testnet-rpc.monad.xyz" : "http://127.0.0.1:8545";
const client = createPublicClient({ transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
const chainId = await client.getChainId();
if (chainId !== (remote ? 10143 : 31337)) throw new Error("Unexpected network");
const { subtle } = webcrypto;
const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
  "sign",
  "verify",
]);
const jwk = await subtle.exportKey("jwk", keys.publicKey);
const x = toHex(Buffer.from(jwk.x, "base64url"));
const y = toHex(Buffer.from(jwk.y, "base64url"));
const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const rp = sha256(stringToHex("localhost"));

async function assertion(challenge) {
  const clientDataJSON = JSON.stringify({
    type: "webauthn.get",
    challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
    origin: "http://localhost:3000",
    crossOrigin: false,
  });
  const authenticatorData = Buffer.concat([
    Buffer.from(rp.slice(2), "hex"),
    Buffer.from([5, 0, 0, 0, 0]),
  ]);
  const payload = Buffer.concat([
    authenticatorData,
    Buffer.from(await subtle.digest("SHA-256", Buffer.from(clientDataJSON))),
  ]);
  const signature = Buffer.from(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, payload),
  );
  const r = toHex(signature.subarray(0, 32));
  const rawS = BigInt(toHex(signature.subarray(32)));
  const s = toHex(rawS > order / 2n ? order - rawS : rawS, { size: 32 });
  return {
    auth: {
      r,
      s,
      challengeIndex: 23n,
      typeIndex: 1n,
      authenticatorData: toHex(authenticatorData),
      clientDataJSON,
    },
    hash: toHex(Buffer.from(await subtle.digest("SHA-256", payload))),
  };
}

if (remote) {
  const vector = await assertion(toHex(webcrypto.getRandomValues(new Uint8Array(32))));
  const data = `0x${[vector.hash, vector.auth.r, vector.auth.s, x, y].map((v) => v.slice(2)).join("")}`;
  const positive = await client.call({ to: "0x0000000000000000000000000000000000000100", data });
  if (!positive.data || BigInt(positive.data) !== 1n)
    throw new Error("Native P256 positive vector failed");
  const negative = await client.call({
    to: "0x0000000000000000000000000000000000000100",
    data: `0x${"00".repeat(32)}${data.slice(66)}`,
  });
  if (negative.data && BigInt(negative.data) !== 0n)
    throw new Error("Native P256 accepted invalid digest");
  console.log(
    JSON.stringify({
      chainId,
      nativeP256: "verified",
      invalidDigest: "rejected",
      mode: "read-only",
      browserAssertion: false,
    }),
  );
} else {
  const artifact = JSON.parse(
    await readFile(
      new URL("../../../contracts/out/WebAuthnProbe.sol/WebAuthnProbe.json", import.meta.url),
      "utf8",
    ),
  );
  const wallet = createWalletClient({ transport: http(rpc) });
  const [account] = await wallet.getAddresses();
  if (!account) throw new Error("Start Anvil with an unlocked local test account");
  const deployHash = await wallet.deployContract({
    account,
    chain: null,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [x, y, rp, "http://localhost:3000"],
  });
  const deployed = await client.waitForTransactionReceipt({ hash: deployHash });
  const address = deployed.contractAddress;
  if (!address || deployed.status !== "success") throw new Error("Probe deployment failed");
  const deadline = (await client.getBlock()).timestamp + 600n;
  const challenge = await client.readContract({
    address,
    abi: artifact.abi,
    functionName: "challenge",
    args: [deadline],
  });
  const { auth } = await assertion(challenge);
  const hash = await wallet.writeContract({
    account,
    chain: null,
    address,
    abi: artifact.abi,
    functionName: "submit",
    args: [deadline, auth],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const nonce = await client.readContract({ address, abi: artifact.abi, functionName: "nonce" });
  if (receipt.status !== "success" || nonce !== 1n) throw new Error("Independent assertion failed");
  let rejected = false;
  try {
    await client.simulateContract({
      address,
      abi: artifact.abi,
      functionName: "submit",
      args: [deadline, auth],
    });
  } catch (error) {
    if (error.cause?.data?.errorName === "InvalidAssertion") rejected = true;
    else throw error;
  }
  if (!rejected) throw new Error("Replay accepted");
  console.log(
    JSON.stringify({
      chainId,
      webCryptoAssertion: "verified",
      replay: "rejected",
      gasUsed: receipt.gasUsed.toString(),
      browserAssertion: false,
    }),
  );
}
