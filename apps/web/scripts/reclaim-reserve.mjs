import { readFile } from "node:fs/promises";
import { resilienceVaultAbi } from "@openbalance/protocol";
import { createVerificationReader, verifyDeployment } from "@openbalance/verifier";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  zeroAddress,
} from "viem";

function endpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("RPC must use HTTPS or loopback HTTP without embedded credentials");
  return url.href;
}

async function main() {
  const [path, flag, ...extra] = process.argv.slice(2);
  if (!path || extra.length || (flag !== undefined && flag !== "--submit"))
    throw new Error("Usage: reclaim-reserve.mjs request.json [--submit]");
  const file = await readFile(path);
  if (file.length > 32_768) throw new Error("Request exceeds size limit");
  const request = JSON.parse(file.toString("utf8"));
  const manifest = request.manifest;
  if (
    !manifest ||
    ![31337, 10143].includes(manifest.chainId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(request.channelId)
  )
    throw new Error("A local or testnet deployment manifest and channel ID are required");
  const rpcUrl = endpoint(request.rpcUrl);
  const chain = {
    id: manifest.chainId,
    name: "Configured test network",
    nativeCurrency: { name: "Gas", symbol: "GAS", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }),
  });
  await verifyDeployment(createVerificationReader(rpcUrl, chain), manifest);
  const block = await client.getBlock({ blockTag: "finalized" });
  const vault = getAddress(manifest.vault.address);
  const args = [request.channelId];
  const [config, state] = await Promise.all([
    client.readContract({
      address: vault,
      abi: resilienceVaultAbi,
      functionName: "channelConfig",
      args,
      blockNumber: block.number,
    }),
    client.readContract({
      address: vault,
      abi: resilienceVaultAbi,
      functionName: "channelState",
      args,
      blockNumber: block.number,
    }),
  ]);
  if (getAddress(state[0]) === zeroAddress) throw new Error("Channel does not exist");
  if (
    config.channelId.toLowerCase() !== request.channelId.toLowerCase() ||
    config.eventId.toLowerCase() !== manifest.eventId.toLowerCase() ||
    getAddress(config.asset) !== getAddress(manifest.asset)
  )
    throw new Error("Channel scope mismatch");
  if (state[4]) throw new Error("Channel is already reclaimed");
  if (block.timestamp < BigInt(config.submitUntil))
    throw new Error("Reserve is not yet eligible for return");
  const caller = getAddress(request.caller);
  if (caller === zeroAddress) throw new Error("A gas-paying caller is required");
  const simulation = await client.simulateContract({
    address: vault,
    abi: resilienceVaultAbi,
    functionName: "reclaim",
    args,
    account: caller,
  });
  const output = {
    status: "PREPARED",
    channelId: request.channelId,
    originalAccount: state[0],
    expectedReturnUnits: simulation.result.toString(),
    finalizedBlock: block.number.toString(),
    finalizedHash: block.hash,
    transaction: {
      to: vault,
      data: encodeFunctionData({ abi: resilienceVaultAbi, functionName: "reclaim", args }),
      value: "0",
    },
  };
  if (!flag) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const wallet = createWalletClient({
    chain,
    transport: http(endpoint(request.walletRpcUrl), { timeout: 15_000, retryCount: 0 }),
  });
  if (
    (await wallet.getChainId()) !== manifest.chainId ||
    !(await wallet.getAddresses()).some((account) => getAddress(account) === caller)
  )
    throw new Error("Wallet RPC does not control the configured caller on this chain");
  const hash = await wallet.writeContract({ ...simulation.request, account: caller, chain });
  console.log(
    JSON.stringify(
      {
        ...output,
        status: "SUBMITTED",
        transactionHash: hash,
        nextAction: "Verify canonical finalized ChannelReclaimed before reporting completion.",
      },
      null,
      2,
    ),
  );
}

main().catch(() => {
  // Provider errors may contain credentials or signed requests. Keep failure output bounded.
  console.error(
    "Reclaim was not confirmed. Check request, deployment, eligibility and wallet configuration; inspect the caller's transactions before retrying an uncertain submission.",
  );
  process.exitCode = 1;
});
