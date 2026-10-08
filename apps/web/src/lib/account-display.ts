import { type Address, createPublicClient, erc20Abi, formatUnits, getAddress, http } from "viem";

/** The testnet event settles in USDC; reserves and the faucet use the same asset. */
export const SETTLEMENT_ASSET = { symbol: "USDC", decimals: 6 } as const;

export function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function formatAmount(units: bigint) {
  const text = formatUnits(units, SETTLEMENT_ASSET.decimals);
  const [whole = "0", fraction = ""] = text.split(".");
  return `${Number(whole).toLocaleString()}.${fraction.padEnd(2, "0").slice(0, 6)}`;
}

/**
 * Reads the account's settlement-asset balance straight from the chain through the public RPC, so
 * the figure shown never depends on our services.
 */
export async function readSettlementBalance(account: Address): Promise<bigint> {
  const rpcUrl = process.env.NEXT_PUBLIC_FINANCIAL_RPC_URL;
  const asset = process.env.NEXT_PUBLIC_SETTLEMENT_ASSET;
  if (!rpcUrl || !asset) throw new Error("Balance reads are not configured.");
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  return client.readContract({
    address: getAddress(asset),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/**
 * Turns WebAuthn and network failures into a sentence a person can act on. Browsers report a
 * cancelled prompt, a missing passkey and a timeout with the same NotAllowedError on purpose, so
 * the message covers all three.
 */
export function passkeyErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError")
      return "The passkey prompt was closed, timed out, or found no passkey for this site on this device.";
    if (error.name === "InvalidStateError")
      return "This device already has a passkey for this account.";
    if (error.name === "TimeoutError" || error.name === "AbortError")
      return "The service took too long to answer. Try again.";
    if (error.name === "TypeError")
      return "The service could not be reached. Check your connection.";
    return error.message;
  }
  return fallback;
}
