import {
  FaucetAccountLimit,
  FaucetExhausted,
  FaucetRejected,
  FaucetService,
  loadFaucetAccount,
  PostgresFaucetLedger,
  ViemFaucetChain,
} from "@openbalance/api/faucet";
import { Pool } from "pg";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./account-scenario.js";
import { loadArtifact } from "./artifacts.js";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

export type FaucetScenarioOptions = {
  rpcUrl: string;
  deployerPrivateKey: `0x${string}`;
  databaseUrl: string;
  maxAmount?: bigint;
  dailyLimit?: bigint;
  accountLimit?: bigint;
};

export type FaucetScenarioResult = {
  kind: "faucet";
  chainId: number;
  token: Address;
  attendee: Address;
  fundedUnits: string;
  attendeeBalance: string;
  overMaxRejected: boolean;
  accountCapEnforced: boolean;
  dailyCapEnforced: boolean;
};

/**
 * Proves the faucet against a live chain and a real PostgreSQL grant ledger: an exact grant to an
 * attendee account, rejection above the per-request maximum, and enforcement of the per-account and daily caps.
 */
export async function runFaucetScenario(
  options: FaucetScenarioOptions,
): Promise<FaucetScenarioResult> {
  const maxAmount = options.maxAmount ?? 5_000_000n;
  const accountLimit = options.accountLimit ?? 6_000_000n;
  const dailyLimit = options.dailyLimit ?? 8_000_000n;
  const chain = chainFor(options.rpcUrl);
  const deployer = privateKeyToAccount(options.deployerPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: deployer });
  const faucetKey = keccak256(stringToHex("faucet:signer"));
  const faucetAccount = privateKeyToAccount(faucetKey);
  const attendee = privateKeyToAccount(keccak256(stringToHex("faucet:attendee"))).address;
  const secondAttendee = privateKeyToAccount(keccak256(stringToHex("faucet:attendee:2"))).address;

  const tokenArtifact = loadArtifact("LocalTestToken.sol", "LocalTestToken");
  const token = await deploy(publicClient, wallet, tokenArtifact, [
    deployer.address,
    1_000_000_000_000n,
  ]);
  await send(wallet, publicClient, {
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [faucetAccount.address, 100_000_000n],
  });
  // The faucet key is independent of the funded mnemonic, so give it native gas to send transfers.
  const gasHash = await wallet.sendTransaction({
    to: faucetAccount.address,
    value: 10n * 10n ** 18n,
    account: deployer,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: gasHash });

  const pool = new Pool({ connectionString: options.databaseUrl, max: 4 });
  try {
    const ledger = new PostgresFaucetLedger(pool);
    await ledger.assertReady();
    const faucet = new FaucetService(
      ledger,
      new ViemFaucetChain({ rpcUrl: options.rpcUrl, chain, account: faucetAccount, token }),
      { chainId: chain.id, token, maxAmount, dailyLimit, accountLimit },
    );

    let step = "grant";
    try {
      const grant = await faucet.fund(attendee, maxAmount);
      const attendeeBalance = (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [attendee],
      })) as bigint;
      if (attendeeBalance !== maxAmount)
        throw new Error("Faucet grant did not credit the attendee");

      step = "over-max";
      const overMaxRejected = await rejects(
        () => faucet.fund(attendee, maxAmount + 1n),
        FaucetRejected,
      );
      step = "account-cap";
      // Within the per-request maximum and the daily budget, but beyond this account's lifetime share.
      const accountCapEnforced = await rejects(
        () => faucet.fund(attendee, accountLimit - maxAmount + 1n),
        FaucetAccountLimit,
      );
      step = "daily-cap";
      // A different account with its own share untouched, so only the shared daily budget can refuse.
      const dailyCapEnforced = await rejects(
        () => faucet.fund(secondAttendee, dailyLimit - maxAmount + 1n),
        FaucetExhausted,
      );

      step = "ledger-readback";
      const rows = await pool.query<{ status: string }>(
        "SELECT status FROM faucet_grants ORDER BY id",
      );
      if (!rows.rows.some((row) => row.status === "GRANTED"))
        throw new Error("Faucet grant was not recorded as granted");
      if (!overMaxRejected || !accountCapEnforced || !dailyCapEnforced)
        throw new Error("Faucet limits were not enforced");

      return {
        kind: "faucet",
        chainId: chain.id,
        token,
        attendee,
        fundedUnits: grant.amount,
        attendeeBalance: attendeeBalance.toString(),
        overMaxRejected,
        accountCapEnforced,
        dailyCapEnforced,
      };
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}${cause ? ` | cause: ${cause.name}: ${cause.message}` : ""}`
          : "unknown";
      throw new Error(`faucet scenario failed at ${step}: ${detail.slice(0, 600)}`);
    }
  } finally {
    await pool.end();
  }
}

async function deploy(
  publicClient: ReturnType<typeof createPublicClient>,
  wallet: ReturnType<typeof createWalletClient>,
  artifact: { abi: readonly unknown[]; bytecode: `0x${string}` },
  args: readonly unknown[],
): Promise<Address> {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account: wallet.account as Account,
    chain: wallet.chain as Chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error("Faucet scenario token deployment failed");
  return receipt.contractAddress;
}

async function send(
  wallet: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  call: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  },
): Promise<void> {
  const hash = await wallet.writeContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    account: wallet.account as Account,
    chain: wallet.chain as Chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${call.functionName} reverted`);
}

/** True only when the operation fails with exactly the expected rejection. */
async function rejects(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    if (error instanceof expected) return true;
    throw error;
  }
}
