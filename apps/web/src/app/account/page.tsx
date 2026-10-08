"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getAddress } from "viem";
import {
  formatAmount,
  passkeyErrorMessage,
  readSettlementBalance,
  SETTLEMENT_ASSET,
  shortAddress,
} from "../../lib/account-display";
import { BrandMark } from "../brand-mark";
import { type ReserveBalance, ReserveBalances, type ReturnOperation } from "./reserve-balances";

type ActivityItem = {
  transitionId: string;
  kind: string;
  aggregateKind: "PAYMENT" | "CHANNEL";
  aggregateId: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
};

type Activity = { items: ActivityItem[]; nextCursor: unknown };

/** How many of the most recent offline balances the account page loads on sign-in. */
const RECENT_RESERVES = 6;

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/** Converts a decimal test amount to base units; returns undefined when it is not representable. */
function toBaseUnits(value: string, decimals: number): string | undefined {
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals) return undefined;
  const units = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return /^[1-9]\d*$/.test(units) ? units : undefined;
}

export default function AccountPage() {
  const [account, setAccount] = useState("");
  const [session, setSession] = useState<string>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity>();
  const [channelId, setChannelId] = useState("");
  const [reserves, setReserves] = useState<ReserveBalance[]>([]);
  const [returns, setReturns] = useState<Record<string, ReturnOperation>>({});
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));
  const [fundAmount, setFundAmount] = useState("5");
  const [funding, setFunding] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [balanceUnavailable, setBalanceUnavailable] = useState(false);
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  const [copied, setCopied] = useState(false);
  const api = process.env.NEXT_PUBLIC_API_URL;

  function report(message: string, nextTone: "info" | "success" | "error" = "info") {
    setStatus(message);
    setTone(nextTone);
  }

  async function loadBalance(address: string) {
    try {
      setBalance(await readSettlementBalance(getAddress(address)));
      setBalanceUnavailable(false);
    } catch {
      setBalanceUnavailable(true);
    }
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(account);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  async function request(path: string, init: RequestInit) {
    if (!api) throw new Error("Account service is not configured.");
    const response = await fetch(`${api}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Passkey authentication was not accepted.");
    return response.json();
  }

  async function relayerRequest(path: string, init: RequestInit) {
    const relayer = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayer) throw new Error("Financial relayer is not configured.");
    const response = await fetch(`${relayer}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        action?: string;
      } | null;
      throw new Error(
        body?.action ?? body?.error?.replaceAll("_", " ") ?? "Reclaim is unavailable.",
      );
    }
    return response.json();
  }

  // Deadlines move from "spend until" to "comes back from" on their own; a coarse tick is enough
  // because the copy shows minutes.
  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1_000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  // A return is final only once the network confirms it; poll until then, then reload the balance.
  useEffect(() => {
    const waiting = Object.entries(returns).filter(
      ([, operation]) => !["FINALIZED", "FAILED", "QUARANTINED"].includes(operation.state),
    );
    if (waiting.length === 0 || !session) return;
    const timer = setTimeout(async () => {
      for (const [id] of waiting) {
        try {
          const next = (await relayerRequest(`/v1/reserve-channels/${id}/reclaims`, {
            method: "GET",
          })) as ReturnOperation;
          setReturns((current) => ({ ...current, [id]: next }));
          if (next.state === "FINALIZED") await loadReserve(session, id as `0x${string}`);
        } catch {
          // A transient status failure leaves the return in place; the next tick asks again.
        }
      }
    }, 3_000);
    return () => clearTimeout(timer);
  });

  async function loadReserve(sessionToken: string, id: `0x${string}`) {
    const reserve = (await request(`/v1/reserve-channels/${id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${sessionToken}` },
    })) as ReserveBalance;
    setReserves((current) => [reserve, ...current.filter((item) => item.channelId !== id)]);
    return reserve;
  }

  async function loadActivity(sessionToken: string) {
    const result = (await request("/v1/accounts/me/activity?limit=25", {
      method: "GET",
      headers: { Authorization: `Bearer ${sessionToken}` },
    })) as Activity;
    setActivity(result);
    const ids = [
      ...new Set(
        result.items
          .filter((item) => item.aggregateKind === "CHANNEL")
          .map((item) => item.aggregateId.toLowerCase() as `0x${string}`),
      ),
    ].slice(0, RECENT_RESERVES);
    const loaded = await Promise.allSettled(
      ids.map(
        async (id) =>
          (await request(`/v1/reserve-channels/${id}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${sessionToken}` },
          })) as ReserveBalance,
      ),
    );
    setReserves(
      loaded.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : [])),
    );
  }

  async function signIn() {
    setBusy(true);
    setSession(undefined);
    try {
      // Discoverable sign-in: the browser offers this site's passkeys and the one chosen names the
      // account, so nothing has to be typed first.
      const start = await request("/v1/accounts/authentication-challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const assertion = await startAuthentication({ optionsJSON: start.options });
      const verified = await request("/v1/accounts/authentications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: start.challengeToken, response: assertion }),
      });
      setAccount(verified.account);
      setSession(verified.sessionToken);
      report("");
      const [, loaded] = await Promise.all([
        loadBalance(verified.account),
        loadActivity(verified.sessionToken).then(
          () => true,
          () => false,
        ),
      ]);
      if (!loaded) report("Signed in. Activity is temporarily unavailable.", "error");
    } catch (error) {
      report(passkeyErrorMessage(error, "Sign-in failed. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function refreshActivity() {
    if (!session) return;
    setBusy(true);
    try {
      await Promise.all([loadActivity(session), loadBalance(account)]);
      report("Up to date.", "success");
    } catch {
      report("Activity is temporarily unavailable. Your account is unchanged.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!session) return;
    setBusy(true);
    try {
      await request("/v1/accounts/sessions/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${session}` },
      });
      setSession(undefined);
      setActivity(undefined);
      setReserves([]);
      setReturns({});
      setBalance(undefined);
      setFunding(undefined);
      report("Signed out.");
    } catch (error) {
      report(error instanceof Error ? error.message : "Sign out failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  /** Looks up an older offline balance that is no longer in the recent activity window. */
  async function lookUpReserve() {
    if (!session || !/^0x[0-9a-fA-F]{64}$/.test(channelId)) {
      report("Enter a valid balance identifier.", "error");
      return;
    }
    setBusy(true);
    try {
      await loadReserve(session, channelId.toLowerCase() as `0x${string}`);
      setChannelId("");
      report("Balance loaded.", "success");
    } catch (error) {
      report(error instanceof Error ? error.message : "That balance is unavailable.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function returnReserve(reserve: ReserveBalance) {
    setBusy(true);
    try {
      // A return needs no session: the vault pays only this account, so the relayer accepts it
      // from anyone and keeps one live return per balance.
      const result = (await relayerRequest(`/v1/reserve-channels/${reserve.channelId}/reclaims`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: reserve.eventId }),
      })) as ReturnOperation;
      setReturns((current) => ({ ...current, [reserve.channelId]: result }));
      report("Return started.", "success");
    } catch (error) {
      report(error instanceof Error ? error.message : "The return was not accepted.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function fundTestBalance() {
    if (!session || !api) return;
    const units = toBaseUnits(fundAmount, 6);
    if (!units) {
      report("Enter a valid test amount with up to six decimals.", "error");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${api}/v1/funding/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
        body: JSON.stringify({ amount: units }),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        const messages: Record<string, string> = {
          faucet_exhausted: "The test faucet has reached its daily limit.",
          faucet_account_limit: "This account has already received its share of test funds.",
          faucet_depleted: "The test faucet is out of funds. Try again later.",
          faucet_rejected: "That amount is above the per-request test funding limit.",
        };
        throw new Error(messages[body?.error ?? ""] ?? "Test funding is unavailable right now.");
      }
      const result = (await response.json()) as { transactionHash: string };
      setFunding(result.transactionHash);
      await loadBalance(account);
      report(`Added ${fundAmount} test USDC to your balance.`, "success");
    } catch (error) {
      report(error instanceof Error ? error.message : "Test funding is unavailable.", "error");
    } finally {
      setBusy(false);
    }
  }

  const notice = (
    <p role="status" aria-live="polite" className={`notice ${tone === "info" ? "" : tone}`}>
      {status}
    </p>
  );

  if (!session)
    return (
      <main>
        <section className="shell narrow">
          <div className="brand-bar">
            <BrandMark />
          </div>
          <h1>Welcome back</h1>
          <p className="summary">
            Sign in with the passkey on this device. Nothing to type, no seed phrase.
          </p>
          <button type="button" className="block-button" disabled={busy} onClick={signIn}>
            {busy ? "Waiting for your passkey…" : "Sign in with passkey"}
          </button>
          {notice}
          <p className="fine-print">
            New here? <Link href="/enroll">Create an account</Link>
          </p>
        </section>
      </main>
    );

  return (
    <main>
      <section className="shell narrow account-shell">
        <div className="account-header">
          <div className="identity">
            <span className="avatar" aria-hidden="true">
              {account.slice(2, 4).toUpperCase()}
            </span>
            <div>
              <small>Monad testnet</small>
              <span className="address-chip" title={account}>
                {shortAddress(account)}
                <button
                  type="button"
                  className="text-button"
                  onClick={copyAddress}
                  aria-label="Copy account address"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </div>
          </div>
          <button
            type="button"
            className="secondary-button sign-out"
            disabled={busy}
            onClick={signOut}
          >
            Sign out
          </button>
        </div>

        <div className="balance-card">
          <span>Available balance</span>
          <strong>
            {balance !== undefined
              ? `${formatAmount(balance)} ${SETTLEMENT_ASSET.symbol}`
              : balanceUnavailable
                ? "Unavailable"
                : "…"}
          </strong>
          <small>Test USDC, read directly from the chain.</small>
          <div className="actions">
            <button type="button" disabled={busy} onClick={refreshActivity}>
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {notice}

        <section className="card" aria-labelledby="funding-heading">
          <div className="section-heading">
            <h2 id="funding-heading">Add test money</h2>
            <p>Test asset only</p>
          </div>
          <p className="muted">
            Free test USDC on Monad testnet. It is not real money and cannot be withdrawn.
          </p>
          <fieldset className="amount-row">
            <legend className="visually-hidden">Test amount</legend>
            {["1", "2", "5"].map((value) => (
              <button
                key={value}
                type="button"
                className="secondary-button"
                aria-pressed={fundAmount === value}
                disabled={busy}
                onClick={() => setFundAmount(value)}
              >
                {value} USDC
              </button>
            ))}
          </fieldset>
          <button type="button" className="block-button" disabled={busy} onClick={fundTestBalance}>
            {busy ? "Working…" : `Add ${fundAmount} USDC`}
          </button>
          {funding && (
            <div className="inline-proof">
              <span>Finalized on chain</span>
              <code title={funding}>{short(funding)}</code>
            </div>
          )}
        </section>

        {activity && (
          <section className="activity" aria-labelledby="balances-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">For when the network drops</p>
                <h2 id="balances-heading">Offline balances</h2>
              </div>
            </div>
            <ReserveBalances
              reserves={reserves}
              operations={returns}
              nowSeconds={nowSeconds}
              busy={busy}
              onReturn={returnReserve}
            />
            <details>
              <summary>Look up an older balance</summary>
              <label>
                Balance identifier
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={channelId}
                  onChange={(event) => setChannelId(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={lookUpReserve}
              >
                Look up balance
              </button>
            </details>
          </section>
        )}

        {activity && (
          <section className="activity" aria-labelledby="activity-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Finalized on chain</p>
                <h2 id="activity-heading">Activity</h2>
              </div>
              <p>{activity.items.length} recent</p>
            </div>
            {activity.items.length === 0 ? (
              <p className="empty-state">No payments or offline balances yet.</p>
            ) : (
              <ol className="activity-list">
                {activity.items.map((item) => (
                  <li key={item.transitionId}>
                    <div>
                      <strong>{item.kind.replaceAll("_", " ").toLowerCase()}</strong>
                      <span>
                        {item.aggregateKind.toLowerCase()} {short(item.aggregateId)}
                      </span>
                    </div>
                    <div className="proof-ref">
                      <span>Block {item.blockNumber}</span>
                      <code title={item.transactionHash}>{short(item.transactionHash)}</code>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
