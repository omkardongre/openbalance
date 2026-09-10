import { readFile } from "node:fs/promises";
import { accountFactoryAbi } from "@openbalance/protocol";
import { createPublicClient, createWalletClient, getAddress, http, keccak256 } from "viem";

// Explicit operator action. Signer stays in a user-controlled wallet RPC.
const [operation, address] = process.argv.slice(2);
if (!["deploy", "manifest"].includes(operation) || (operation === "manifest" && !address))
  throw new Error("Usage: deploy-account-factory.mjs deploy | manifest FACTORY_ADDRESS");
const rpc = process.env.ACCOUNT_RPC_URL;
if (!rpc) throw new Error("ACCOUNT_RPC_URL is required");
function transport(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))
  )
    throw new Error("RPC must use HTTPS or loopback HTTP");
  return http(url, { timeout: 120000, retryCount: 0 });
}
const client = createPublicClient({ transport: transport(rpc) });
const chainId = await client.getChainId();
if (![31337, 10143].includes(chainId))
  throw new Error("Only local and testnet deployment is enabled");
const factory = address ? getAddress(address) : undefined;
if (operation === "deploy") {
  if (!process.env.ACCOUNT_WALLET_RPC_URL || !process.env.ACCOUNT_DEPLOYER_ADDRESS)
    throw new Error("ACCOUNT_WALLET_RPC_URL and ACCOUNT_DEPLOYER_ADDRESS are required");
  const wallet = createWalletClient({ transport: transport(process.env.ACCOUNT_WALLET_RPC_URL) });
  const account = getAddress(process.env.ACCOUNT_DEPLOYER_ADDRESS);
  if (
    (await wallet.getChainId()) !== chainId ||
    !(await wallet.getAddresses()).some((item) => getAddress(item) === account)
  )
    throw new Error("Wallet identity or chain mismatch");
  const artifact = JSON.parse(
    await readFile(
      new URL("../../../contracts/out/AccountFactory.sol/AccountFactory.json", import.meta.url),
      "utf8",
    ),
  );
  const receipt = await client.waitForTransactionReceipt({
    hash: await wallet.deployContract({
      account,
      chain: null,
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
    }),
  });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("Factory deployment failed");
  console.log(
    JSON.stringify(
      {
        factory: receipt.contractAddress,
        transactionHash: receipt.transactionHash,
        status: "mined",
        next: "After finality, run manifest with this factory address. Do not redeploy on a manifest-read failure.",
      },
      null,
      2,
    ),
  );
} else {
  const block = await client.getBlock({ blockTag: "finalized" });
  const factoryCode = await client.getCode({ address: factory, blockNumber: block.number });
  if (!factoryCode || factoryCode === "0x")
    throw new Error("Factory is not present at the finalized checkpoint");
  const implementation = await client.readContract({
    address: factory,
    abi: accountFactoryAbi,
    functionName: "implementation",
    blockNumber: block.number,
  });
  const implementationCode = await client.getCode({
    address: implementation,
    blockNumber: block.number,
  });
  if (!implementationCode || implementationCode === "0x")
    throw new Error("Implementation code missing");
  console.log(
    JSON.stringify(
      {
        version: 1,
        chainId,
        factory,
        factoryCodeHash: keccak256(factoryCode),
        implementation,
        implementationCodeHash: keccak256(implementationCode),
      },
      null,
      2,
    ),
  );
}
