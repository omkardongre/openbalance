import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountAbi, accountCommandDigest, ownershipHash } from "@openbalance/protocol";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  sha256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";

const rpc = "http://127.0.0.1:8545";
const client = createPublicClient({ transport: http(rpc) });
if ((await client.getChainId()) !== 31337) throw new Error("Requires local Anvil chain 31337");
const wallet = createWalletClient({ transport: http(rpc) });
const [signer] = await wallet.getAddresses();
const artifact = JSON.parse(
  await readFile(
    new URL("../../../contracts/out/AccountFactory.sol/AccountFactory.json", import.meta.url),
    "utf8",
  ),
);
const deployed = await client.waitForTransactionReceipt({
  hash: await wallet.deployContract({
    account: signer,
    chain: null,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
  }),
});
const factory = deployed.contractAddress;
function ownership() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    primary: {
      x: `0x${Buffer.from(jwk.x, "base64url").toString("hex")}`,
      y: `0x${Buffer.from(jwk.y, "base64url").toString("hex")}`,
    },
    backup: { x: zeroHash, y: zeroHash },
    recovery: signer,
  };
}
const initial = ownership();
const args = [initial, sha256(stringToHex("localhost")), "http://localhost:3000", zeroHash];
const account = await client.readContract({
  address: factory,
  abi: artifact.abi,
  functionName: "predict",
  args,
});
await client.waitForTransactionReceipt({
  hash: await wallet.writeContract({
    account: signer,
    chain: null,
    address: factory,
    abi: artifact.abi,
    functionName: "create",
    args,
  }),
});
const implementation = await client.readContract({
  address: factory,
  abi: artifact.abi,
  functionName: "implementation",
});
const next = ownership();
next.recovery = zeroAddress;
const deadline = (await client.getBlock()).timestamp + 600n;
const digest = accountCommandDigest({
  chainId: 31337,
  account,
  action: "RECOVER",
  terms: ownershipHash(next),
  epoch: 1n,
  nonce: 0n,
  deadline,
});
const onchain = await client.readContract({
  address: account,
  abi: accountAbi,
  functionName: "commandDigest",
  args: [keccak256(stringToHex("RECOVER")), ownershipHash(next), deadline],
});
if (digest !== onchain) throw new Error("Cross-language digest mismatch");
const directory = await mkdtemp(join(tmpdir(), "openbalance-recovery-test-"));
try {
  const path = join(directory, "request.json");
  await writeFile(
    path,
    JSON.stringify({
      chainId: 31337,
      account,
      rpcUrl: rpc,
      walletRpcUrl: rpc,
      ownership: next,
      deadline: deadline.toString(),
      accountCodeHash: keccak256(await client.getCode({ address: account })),
      implementationCodeHash: keccak256(await client.getCode({ address: implementation })),
    }),
  );
  execFileSync(
    process.execPath,
    [new URL("./recover-account.mjs", import.meta.url).pathname, path, "--sign", "--submit"],
    { stdio: "pipe" },
  );
  const epoch = await client.readContract({
    address: account,
    abi: accountAbi,
    functionName: "epoch",
  });
  if (epoch !== 2n) throw new Error("Recovery epoch not advanced");
  let rejected = false;
  try {
    execFileSync(
      process.execPath,
      [new URL("./recover-account.mjs", import.meta.url).pathname, path, "--sign", "--submit"],
      { stdio: "pipe" },
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Disabled recovery signer was accepted");
  console.log(
    JSON.stringify({
      chainId: 31337,
      digestMatch: true,
      recoveryConfirmed: true,
      disabledSignerRejected: true,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
