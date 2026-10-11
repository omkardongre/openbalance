import { getAddress, type Hex } from "viem";

/** EIP-1193 provider injected by a browser wallet such as MetaMask. */
export type InjectedWallet = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};

export function injectedWallet(): InjectedWallet {
  const ethereum = (window as unknown as { ethereum?: InjectedWallet }).ethereum;
  if (!ethereum)
    throw new Error("No browser wallet found. Open this page where MetaMask is installed.");
  return ethereum;
}

export function shortAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

const MONAD_TESTNET = {
  chainId: "0x279f",
  chainName: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: ["https://testnet-rpc.monad.xyz"],
  blockExplorerUrls: ["https://testnet.monadexplorer.com"],
};

/** Asks the wallet to switch to the event's network, adding Monad Testnet if it does not know it. */
export async function ensureChain(wallet: InjectedWallet, chainId: number) {
  const wanted = `0x${chainId.toString(16)}`;
  const current = (await wallet.request({ method: "eth_chainId" })) as string;
  if (current.toLowerCase() === wanted) return;
  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902 || wanted !== MONAD_TESTNET.chainId)
      throw new Error("Switch your wallet to Monad Testnet, then try again.");
    await wallet.request({ method: "wallet_addEthereumChain", params: [MONAD_TESTNET] });
  }
}

export async function connectedAccount(wallet: InjectedWallet) {
  const [account] = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
  if (!account) throw new Error("Connect a wallet account to continue.");
  return getAddress(account);
}

type PreparedOperation = {
  operationId: string;
  state: "PREPARED" | "FINALIZED";
  transaction: { from: `0x${string}`; to: `0x${string}`; data: Hex; value: "0x0"; chainId: Hex };
  statusUrl: string;
};

async function stableKey(prefix: string, value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${prefix}-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const TOO_MANY_REQUESTS = "Too many requests right now. Wait a few seconds and try again.";

/** A request that may succeed if repeated later: rate limited, a server hiccup, or no answer. */
export class TransientRequestError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** Server-requested wait (Retry-After, in seconds), otherwise the caller's default. */
export function retryAfterMs(response: Response, fallback: number) {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 60_000) : fallback;
}

/** Exponential backoff with full jitter, capped, so devices behind one IP do not retry in step. */
function backoff(attempt: number, floor: number) {
  const ceiling = Math.min(15_000, 3_000 * 2 ** attempt);
  return Math.max(floor, Math.round(Math.random() * ceiling));
}

/**
 * One registry change, end to end: the API prepares and simulates it, the organizer wallet signs and
 * sends it, and the API confirms it from the finalized chain. Resolves only once it is final, so the
 * next step (which the API simulates at the finalized block) sees it.
 */
export async function runRegistryOperation(input: {
  api: string;
  token: string;
  eventId: Hex;
  chainId: number;
  body: Record<string, unknown>;
  onProgress?: (message: string) => void;
}) {
  const call = async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${input.token}`);
    headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${input.api}${path}`, {
        ...init,
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new TransientRequestError("The service did not answer. Try again.", 3_000);
    }
    if (response.status === 429)
      throw new TransientRequestError(TOO_MANY_REQUESTS, retryAfterMs(response, 5_000));
    if (response.status >= 500)
      throw new TransientRequestError("The service is busy. Try again.", 3_000);
    const body = (await response.json().catch(() => null)) as
      | (PreparedOperation & { error?: string; confirmation?: string })
      | null;
    if (!response.ok || !body) {
      if (body?.error === "configuration_state_mismatch")
        throw new Error(
          "The network has not caught up with the previous step yet. Try again shortly.",
        );
      throw new Error("The registry change was not accepted. Try again.");
    }
    return body;
  };
  const wallet = injectedWallet();
  input.onProgress?.("Preparing…");
  const key = await stableKey(`stall-${String(input.body.kind).toLowerCase()}`, input.body);
  const prepared = await call(
    `/v1/events/${encodeURIComponent(input.eventId)}/configuration-operations`,
    { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(input.body) },
  );
  if (prepared.state === "FINALIZED") return;
  const account = await connectedAccount(wallet);
  if (account !== getAddress(prepared.transaction.from))
    throw new Error(
      `Switch MetaMask to your organizer wallet (${shortAddress(prepared.transaction.from)}), then try again.`,
    );
  await ensureChain(wallet, input.chainId);
  input.onProgress?.("Confirm in your wallet…");
  const transactionHash = (await wallet.request({
    method: "eth_sendTransaction",
    params: [prepared.transaction],
  })) as Hex;
  input.onProgress?.("Waiting for the network to confirm…");
  // The transaction is already sent, so a failed status check is never a failed change: keep
  // asking (backing off on rate limits and server errors) for up to about three minutes.
  const giveUpAt = Date.now() + 180_000;
  for (let attempt = 0; Date.now() < giveUpAt; attempt++) {
    try {
      const checked = await call(`${prepared.statusUrl}/confirmations`, {
        method: "POST",
        body: JSON.stringify({ transactionHash }),
      });
      if (checked.state === "FINALIZED") return;
      await wait(3_000);
    } catch (error) {
      if (!(error instanceof TransientRequestError)) throw error;
      await wait(backoff(attempt, error.retryAfterMs));
    }
  }
  throw new Error("Sent, but the network is slow to confirm. Check again in a minute.");
}
