import { accountAbi, accountFactoryAbi } from "@openbalance/protocol";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadArtifact } from "./artifacts.js";
import { VirtualAuthenticator, type WebAuthnAssertion } from "./authenticator.js";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
]);

const WITHDRAW = keccak256(stringToHex("WITHDRAW"));
const RECOVER = keccak256(stringToHex("RECOVER"));

export type AccountScenarioOptions = {
  rpcUrl: string;
  deployerPrivateKey: Hex;
  rpId?: string;
  origin?: string;
};

export type AccountScenarioResult = {
  chainId: number;
  token: Address;
  factory: Address;
  account: Address;
  predictedAccount: Address;
  recoverySigner: Address;
  withdrawTransaction: Hex;
  recoveryTransaction: Hex;
  withdrawnUnits: string;
  accountEpoch: string;
  staleAssertionRejected: boolean;
};

/** Builds the local Anvil chain definition bound to the scenario's RPC endpoint. */
export function chainFor(rpcUrl: string, chainId = 31_337) {
  return defineChain({
    id: chainId,
    name: chainId === 31_337 ? "Local Anvil" : `Chain ${chainId}`,
    nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/**
 * Resolves the chain definition by asking the endpoint which chain it serves.
 *
 * The identifier is not cosmetic. It is signed into voucher and refund-intent digests and into the
 * transaction's own replay protection, so assuming the local development chain produces signatures
 * that a public chain's contracts reject as invalid — correctly, since they authorize an action on a
 * different chain. Reading it is the only way to be right against both.
 */
export async function resolveChainFor(rpcUrl: string) {
  const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
  return chainFor(rpcUrl, chainId);
}

/**
 * Runs the account ownership journey against a live RPC: a real virtual passkey creates and
 * controls an account, performs a WebAuthn-authorized withdrawal, then a separate recovery
 * signer rotates ownership and invalidates the old passkey. Every authorization is verified by
 * the deployed contract, not by the scenario harness.
 */
export async function runAccountScenario(
  options: AccountScenarioOptions,
): Promise<AccountScenarioResult> {
  const rpId = options.rpId ?? "localhost";
  const origin = options.origin ?? "http://localhost:3000";
  const chain = chainFor(options.rpcUrl);
  const deployer = privateKeyToAccount(options.deployerPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: deployer });

  const tokenArtifact = loadArtifact("LocalTestToken.sol", "LocalTestToken");
  const factoryArtifact = loadArtifact("AccountFactory.sol", "AccountFactory");

  const tokenHash = await wallet.deployContract({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
    args: [deployer.address, 1_000_000_000_000n],
    account: deployer,
    chain,
  });
  const tokenReceipt = await publicClient.waitForTransactionReceipt({ hash: tokenHash });
  if (!tokenReceipt.contractAddress) throw new Error("Local test token deployment failed");

  const factoryHash = await wallet.deployContract({
    abi: factoryArtifact.abi,
    bytecode: factoryArtifact.bytecode,
    args: [],
    account: deployer,
    chain,
  });
  const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
  if (!factoryReceipt.contractAddress) throw new Error("Account factory deployment failed");

  const token = tokenReceipt.contractAddress;
  const factory = factoryReceipt.contractAddress;

  const passkey = VirtualAuthenticator.create({ rpId, origin });
  const recoverySigner = privateKeyToAccount(keccak256(stringToHex(`recovery:${Date.now()}`)));
  const userSalt = keccak256(stringToHex(`salt:${Date.now()}`));
  const ownership = {
    primary: passkey.publicKey,
    backup: { x: `0x${"00".repeat(32)}` as Hex, y: `0x${"00".repeat(32)}` as Hex },
    recovery: recoverySigner.address,
  };

  const predictedAccount = await publicClient.readContract({
    address: factory,
    abi: accountFactoryAbi,
    functionName: "predict",
    args: [ownership, passkey.rpIdHash, origin, userSalt],
  });
  const createHash = await wallet.writeContract({
    address: factory,
    abi: accountFactoryAbi,
    functionName: "create",
    args: [ownership, passkey.rpIdHash, origin, userSalt],
    account: deployer,
    chain,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") throw new Error("Account creation reverted");
  const account = predictedAccount;
  if ((await publicClient.getCode({ address: account })) === undefined)
    throw new Error("Account was not deployed at its predicted address");

  const funding = 25_000_000n;
  const transferHash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [account, funding],
    account: deployer,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: transferHash });

  const recipient = deployer.address;
  const amount = 7_500_000n;
  const deadline = BigInt(await publicClient.getBlock().then((block) => block.timestamp + 3_600n));
  const terms = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [token, recipient, amount],
    ),
  );
  const digest = await publicClient.readContract({
    address: account,
    abi: accountAbi,
    functionName: "commandDigest",
    args: [WITHDRAW, terms, deadline],
  });
  const assertion = passkey.assert(digest);
  const before = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [recipient],
  });
  const withdrawTransaction = await wallet.writeContract({
    address: account,
    abi: accountAbi,
    functionName: "withdraw",
    args: [token, recipient, amount, deadline, false, toAuth(assertion)],
    account: deployer,
    chain,
  });
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({
    hash: withdrawTransaction,
  });
  if (withdrawReceipt.status !== "success") throw new Error("WebAuthn withdrawal reverted");
  const after = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [recipient],
  });
  if (after - before !== amount) throw new Error("Withdrawal did not move the exact amount");

  const newPrimary = VirtualAuthenticator.create({ rpId, origin });
  const rotated = {
    primary: newPrimary.publicKey,
    backup: ownership.backup,
    recovery: recoverySigner.address,
  };
  const recoveryDeadline = BigInt(
    await publicClient.getBlock().then((block) => block.timestamp + 3_600n),
  );
  const recoveryTerms = keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            {
              name: "primary",
              type: "tuple",
              components: [
                { name: "x", type: "bytes32" },
                { name: "y", type: "bytes32" },
              ],
            },
            {
              name: "backup",
              type: "tuple",
              components: [
                { name: "x", type: "bytes32" },
                { name: "y", type: "bytes32" },
              ],
            },
            { name: "recovery", type: "address" },
          ],
        },
      ],
      [rotated],
    ),
  );
  const recoveryDigest = await publicClient.readContract({
    address: account,
    abi: accountAbi,
    functionName: "commandDigest",
    args: [RECOVER, recoveryTerms, recoveryDeadline],
  });
  const recoverySignature = await recoverySigner.sign({ hash: recoveryDigest });
  const recoveryTransaction = await wallet.writeContract({
    address: account,
    abi: accountAbi,
    functionName: "recover",
    args: [rotated, recoveryDeadline, recoverySignature],
    account: deployer,
    chain,
  });
  const recoveryReceipt = await publicClient.waitForTransactionReceipt({
    hash: recoveryTransaction,
  });
  if (recoveryReceipt.status !== "success") throw new Error("Recovery transaction reverted");

  const epoch = await publicClient.readContract({
    address: account,
    abi: accountAbi,
    functionName: "epoch",
  });
  if (epoch !== 2n) throw new Error("Recovery did not advance the ownership epoch");

  const staleAssertionRejected = await rejectsStaleAssertion({
    publicClient,
    wallet,
    deployer,
    accountAddress: account,
    token,
    recipient,
    passkey,
    chain,
  });

  return {
    chainId: chain.id,
    token,
    factory,
    account,
    predictedAccount,
    recoverySigner: recoverySigner.address,
    withdrawTransaction,
    recoveryTransaction,
    withdrawnUnits: amount.toString(),
    accountEpoch: epoch.toString(),
    staleAssertionRejected,
  };
}

async function rejectsStaleAssertion(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  wallet: ReturnType<typeof createWalletClient>;
  deployer: ReturnType<typeof privateKeyToAccount>;
  accountAddress: Address;
  token: Address;
  recipient: Address;
  passkey: VirtualAuthenticator;
  chain: ReturnType<typeof chainFor>;
}): Promise<boolean> {
  const deadline = BigInt(
    await input.publicClient.getBlock().then((block) => block.timestamp + 3_600n),
  );
  const terms = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [input.token, input.recipient, 1n],
    ),
  );
  const digest = await input.publicClient.readContract({
    address: input.accountAddress,
    abi: accountAbi,
    functionName: "commandDigest",
    args: [WITHDRAW, terms, deadline],
  });
  const staleAuth = toAuth(input.passkey.assert(digest));
  try {
    await input.wallet.writeContract({
      address: input.accountAddress,
      abi: accountAbi,
      functionName: "withdraw",
      args: [input.token, input.recipient, 1n, deadline, false, staleAuth],
      account: input.deployer,
      chain: input.chain,
    });
    return false;
  } catch {
    return true;
  }
}

function toAuth(assertion: WebAuthnAssertion) {
  return {
    r: assertion.r,
    s: assertion.s,
    challengeIndex: assertion.challengeIndex,
    typeIndex: assertion.typeIndex,
    authenticatorData: assertion.authenticatorData,
    clientDataJSON: assertion.clientDataJSON,
  };
}
