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
    return friendlyError(error, fallback);
  }
  return fallback;
}

/** Known failures, keyed by a fragment of the API error code or library message. */
const KNOWN_ERRORS: [RegExp, string][] = [
  [/faucet_account_limit/i, "You have already received the most test money one account can get."],
  [/faucet_(depleted|daily|budget)/i, "Test money has run out for today. Try again later."],
  [/rate.?limit|too many|\b429\b/i, "Too many tries in a row. Wait a minute and try again."],
  [/changed while/i, "Something changed during approval. Scan the stall's code again."],
  [/already authorized|already stored/i, "This payment was already approved on this phone."],
  [/receipt does not match/i, "That receipt is not for a payment made on this phone."],
  [/not finalized and active/i, "This reserve is not ready yet. Try again in a minute."],
  [/insufficient|exceeds/i, "Not enough money for this. Add funds and try again."],
  [/expired/i, "This code has expired. Ask the stall to show a new one."],
  [/session|unauthori[sz]ed|401/i, "Your session ended. Sign in again to continue."],
];

/** Words a person paying at a stall should never have to read. */
const TECHNICAL =
  /\b(rpc|channel|voucher|vault|nonce|payload|signature|signer|sequence|finaliz\w*|indexer|relay\w*|sponsor\w*|deploy\w*|contract|hash|block|identifier|credential|binding|intent|DER|integer|configured|parameters|origin|chain)\b|0x[0-9a-f]|_[a-z]/i;

/**
 * Turns any thrown error into a sentence a non-technical person can act on. Known failures get a
 * specific message; anything else that reads like an internal detail falls back to `fallback`.
 */
export function friendlyError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return fallback;
  for (const [pattern, text] of KNOWN_ERRORS) if (pattern.test(message)) return text;
  return TECHNICAL.test(message) || message.length > 140 ? fallback : message;
}
