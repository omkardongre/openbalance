"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { type ReserveBalance, ReserveBalances, type ReturnOperation } from "./reserve-balances";

const accountPattern = /^0x[0-9a-fA-F]{40}$/;

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
  const api = process.env.NEXT_PUBLIC_API_URL;

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
    if (!accountPattern.test(account)) {
      setStatus("Enter a valid account address.");
      return;
    }
    setBusy(true);
    setSession(undefined);
    try {
      const start = await request("/v1/accounts/authentication-challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account }),
      });
      const assertion = await startAuthentication({ optionsJSON: start.options });
      const verified = await request("/v1/accounts/authentications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: start.challengeToken, response: assertion }),
      });
      setAccount(verified.account);
      setSession(verified.sessionToken);
      try {
        await loadActivity(verified.sessionToken);
        setStatus("Account access verified. Activity is finalized onchain data.");
      } catch {
        setStatus("Account access verified. Finalized activity is temporarily unavailable.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshActivity() {
    if (!session) return;
    setBusy(true);
    try {
      await loadActivity(session);
      setStatus("Finalized activity refreshed.");
    } catch {
      setStatus("Finalized activity is temporarily unavailable. Your account is unchanged.");
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
      setStatus("Session revoked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign out failed.");
    } finally {
      setBusy(false);
    }
  }

  /** Looks up an older offline balance that is no longer in the recent activity window. */
  async function lookUpReserve() {
    if (!session || !/^0x[0-9a-fA-F]{64}$/.test(channelId)) {
      setStatus("Enter a valid balance identifier.");
      return;
    }
    setBusy(true);
    try {
      await loadReserve(session, channelId.toLowerCase() as `0x${string}`);
      setChannelId("");
      setStatus("Balance loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That balance is unavailable.");
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
      setStatus("Return started.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The return was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  async function fundTestBalance() {
    if (!session || !api) return;
    const units = toBaseUnits(fundAmount, 6);
    if (!units) {
      setStatus("Enter a valid test amount with up to six decimals.");
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
      setStatus("Test balance funded. This is test money, not card funding.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Test funding is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="shell account-shell">
        <p className="eyebrow">OpenBalance account</p>
        <h1>Use your passkey.</h1>
        <p className="summary">Authenticate without a seed phrase or shared account password.</p>
        <label htmlFor="account-address">Account address</label>
        <input
          id="account-address"
          autoComplete="off"
          spellCheck={false}
          value={account}
          disabled={busy || Boolean(session)}
          onChange={(event) => setAccount(event.target.value)}
        />
        {session ? (
          <div className="actions">
            <button type="button" disabled={busy} onClick={refreshActivity}>
              Refresh finalized activity
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </div>
        ) : (
          <button type="button" disabled={busy} onClick={signIn}>
            {busy ? "Verifying…" : "Continue with passkey"}
          </button>
        )}
        <p role="status">{status}</p>
        {session && activity && (
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
              <button type="button" disabled={busy} onClick={lookUpReserve}>
                Look up balance
              </button>
            </details>
          </section>
        )}
        {session && activity && (
          <section className="activity" aria-labelledby="activity-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Finalized history</p>
                <h2 id="activity-heading">Account activity</h2>
              </div>
              <p>{activity.items.length} recent transitions</p>
            </div>
            {activity.items.length === 0 ? (
              <p className="empty-state">No finalized payments or reserve transitions yet.</p>
            ) : (
              <ol className="activity-list">
                {activity.items.map((item) => (
                  <li key={item.transitionId}>
                    <div>
                      <strong>{item.kind.replaceAll("_", " ")}</strong>
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
        {session && (
          <section className="activity" aria-labelledby="funding-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Test money</p>
                <h2 id="funding-heading">Fund a test balance</h2>
              </div>
              <p>Test asset only</p>
            </div>
            <p className="summary">
              This faucet grants a clearly labelled test asset on the test network. It is not card
              funding and cannot be withdrawn as real money.
            </p>
            <label>
              Test amount
              <input
                inputMode="decimal"
                value={fundAmount}
                disabled={busy}
                onChange={(event) => setFundAmount(event.target.value)}
              />
            </label>
            <button type="button" disabled={busy} onClick={fundTestBalance}>
              Fund test balance
            </button>
            {funding && (
              <div className="proof-ref">
                <span>Test funding finalized</span>
                <code title={funding}>{short(funding)}</code>
              </div>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
