import { readFile } from "node:fs/promises";
import { accountAbi, accountCommand, ownershipHash } from "@openbalance/protocol";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  verifyTypedData,
} from "viem";

// Wallet RPC must expose a user-controlled signing account. No key material is accepted here.
const [requestPath, ...flags] = process.argv.slice(2);
if (
  !requestPath ||
  flags.some((flag) => !["--sign", "--submit"].includes(flag)) ||
  (flags.includes("--submit") && !flags.includes("--sign"))
)
  throw new Error("Usage: recover-account.mjs request.json [--sign [--submit]]");
const request = JSON.parse(await readFile(requestPath, "utf8"));
if (![10143, 31337].includes(request.chainId))
  throw new Error("Only testnet and local recovery are enabled");
function endpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    throw new Error("RPC must use HTTPS or local HTTP");
  return value;
}
const account = getAddress(request.account);
const owners = request.ownership;
for (const key of [owners.primary, owners.backup])
  for (const coordinate of [key.x, key.y])
    if (!/^0x[0-9a-fA-F]{64}$/.test(coordinate)) throw new Error("Invalid P256 coordinate");
owners.recovery = getAddress(owners.recovery);
const client = createPublicClient({
  transport: http(endpoint(request.rpcUrl), { timeout: 15000, retryCount: 1 }),
});
if ((await client.getChainId()) !== request.chainId) throw new Error("RPC chain mismatch");
const code = await client.getCode({ address: account });
if (!code || keccak256(code) !== request.accountCodeHash)
  throw new Error("Account code does not match the trusted deployment record");
if (!/^0x363d3d373d3d3d363d73[0-9a-fA-F]{40}5af43d82803e903d91602b57fd5bf3$/.test(code))
  throw new Error("Unsupported account proxy");
const implementation = getAddress(`0x${code.slice(22, 62)}`);
const implementationCode = await client.getCode({ address: implementation });
if (!implementationCode || keccak256(implementationCode) !== request.implementationCodeHash)
  throw new Error("Account implementation does not match the trusted deployment record");
const block = await client.getBlock();
const read = (functionName) =>
  client.readContract({
    address: account,
    abi: accountAbi,
    functionName,
    blockNumber: block.number,
  });
const [epoch, nonce, currentOwners] = await Promise.all([
  read("epoch"),
  read("recoveryNonce"),
  read("ownership"),
]);
const signer = currentOwners[2];
if (signer === "0x0000000000000000000000000000000000000000")
  throw new Error("Recovery is disabled");
const terms = ownershipHash(owners);
const deadline = BigInt(request.deadline);
if (deadline <= block.timestamp || deadline > block.timestamp + 900n)
  throw new Error("Use an expiry within the next 15 minutes");
const typedData = accountCommand({
  chainId: request.chainId,
  account,
  action: "RECOVER",
  terms,
  epoch,
  nonce,
  deadline,
});
const digest = hashTypedData(typedData);
const onchain = await client.readContract({
  address: account,
  abi: accountAbi,
  functionName: "commandDigest",
  args: [keccak256(stringToHex("RECOVER")), terms, deadline],
  blockNumber: block.number,
});
if (digest !== onchain) throw new Error("Typed data does not match contract digest");
const json = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2);
console.log(json({ account, signer, ownership: owners, typedData, digest }));
if (flags.includes("--sign")) {
  const wallet = createWalletClient({
    transport: http(endpoint(request.walletRpcUrl), { timeout: 120000, retryCount: 0 }),
  });
  if ((await wallet.getChainId()) !== request.chainId) throw new Error("Wallet chain mismatch");
  if (
    !(await wallet.getAddresses()).some((address) => address.toLowerCase() === signer.toLowerCase())
  )
    throw new Error("Wallet does not expose the enrolled recovery address");
  const signature = await wallet.signTypedData({ ...typedData, account: signer });
  if (!(await verifyTypedData({ ...typedData, address: signer, signature })))
    throw new Error("Wallet signature mismatch");
  const args = [owners, deadline, signature];
  await client.simulateContract({
    address: account,
    abi: accountAbi,
    functionName: "recover",
    args,
    account: signer,
  });
  const data = encodeFunctionData({ abi: accountAbi, functionName: "recover", args });
  // The envelope authorizes recovery until expiry; do not publish it unintentionally.
  console.log(json({ to: account, data, chainId: request.chainId, deadline }));
  if (flags.includes("--submit")) {
    const hash = await wallet.sendTransaction({ account: signer, chain: null, to: account, data });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Recovery transaction reverted");
    const updated = await client.readContract({
      address: account,
      abi: accountAbi,
      functionName: "ownership",
      blockNumber: receipt.blockNumber,
    });
    if (ownershipHash({ primary: updated[0], backup: updated[1], recovery: updated[2] }) !== terms)
      throw new Error("Recovery read-back mismatch");
    console.log(json({ transactionHash: hash, status: "confirmed" }));
  }
}
