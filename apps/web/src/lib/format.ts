import { formatUnits } from "viem";
import { SETTLEMENT_ASSET } from "./account-display";

/** Public block explorer for the testnet the deployment runs on. */
const EXPLORER = "https://testnet.monadexplorer.com";

export function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`;
}

/**
 * An amount the way a wallet shows it: at least two decimals, trailing zeros beyond that trimmed,
 * with the asset symbol. `1000000` base units of USDC reads "1.00 USDC".
 */
export function money(
  units: bigint | string,
  asset: { symbol: string; decimals: number } = SETTLEMENT_ASSET,
) {
  const [whole = "0", fraction = ""] = formatUnits(BigInt(units), asset.decimals).split(".");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${BigInt(whole).toLocaleString()}.${trimmed} ${asset.symbol}`;
}

/** "Today, 15:31", "Yesterday, 09:02" or "8 Oct, 19:59". */
export function when(value: Date | number) {
  const date = typeof value === "number" ? new Date(value) : value;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}
