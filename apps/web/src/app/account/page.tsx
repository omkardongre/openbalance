"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getAddress } from "viem";
import {
  formatAmount,
  friendlyError,
  passkeyErrorMessage,
  readSettlementBalance,
  SETTLEMENT_ASSET,
  shortAddress,
} from "../../lib/account-display";
import { explorerTx } from "../../lib/format";
import { useVendorNames } from "../../lib/reserve-terms";
import { AttendeeNav } from "../attendee-nav";
import { BrandMark } from "../brand-mark";
import { useSession } from "../session-provider";
import { type ActivityItem, ActivityList } from "./activity-list";
import { OpenReserve } from "./open-reserve";
import { type ReserveBalance, ReserveBalances, type ReturnOperation } from "./reserve-balances";

type Page<T, C> = { items: T[]; nextCursor: C | null };
type ActivityCursor = { blockNumber: string; transitionId: string };
type ReserveCursor = { openedBlock: string; channelId: string };

/** Rows per page; small enough that a phone shows a page without endless scrolling. */
const ACTIVITY_PAGE = 10;
const RESERVE_PAGE = 5;

class SessionEnded extends Error {}

/** Converts a decimal test amount to base units; returns undefined when it is not representable. */
function toBaseUnits(value: string, decimals: number): string | undefined {
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > decimals) return undefined;
  const units = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return /^[1-9]\d*$/.test(units) ? units : undefined;
}

export default function AccountPage() {
  const { session, signedIn, signedOut } = useSession();
  /** The reserve whose return is being sent, so only its button shows progress. */
  const [returning, setReturning] = useState<string>();
  const account = session?.account ?? "";
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Page<ActivityItem, ActivityCursor>>();
  const [reserves, setReserves] = useState<Page<ReserveBalance, ReserveCursor>>();
  const [loadingMore, setLoadingMore] = useState<"activity" | "reserves">();
  const [returns, setReturns] = useState<Record<string, ReturnOperation>>({});
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));
  const [fundAmount, setFundAmount] = useState("5");
  const [funding, setFunding] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [balanceUnavailable, setBalanceUnavailable] = useState(false);
  const [copied, setCopied] = useState(false);
  const vendors = useVendorNames();
  const api = process.env.NEXT_PUBLIC_API_URL;

  function report(message: string, nextTone: "info" | "success" | "error" = "info") {
    setStatus(message);
    setTone(nextTone);
  }

  const request = useCallback(
    async (path: string, init: RequestInit = { method: "GET" }) => {
      if (!api) throw new Error("Account service is not configured.");
      const response = await fetch(`${api}${path}`, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401) throw new SessionEnded();
      if (!response.ok) throw new Error("The account service could not answer. Try again.");
      return response.json();
    },
    [api],
  );

  const authorized = useCallback(
    (path: string) => {
      if (!session) throw new SessionEnded();
      return request(path, {
        method: "GET",
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      });
    },
    [request, session],
  );

  /** An expired session is not an error the person caused: say so and show the sign-in screen. */
  const failed = useCallback(
    (error: unknown, message: string) => {
      if (error instanceof SessionEnded) {
        signedOut();
        setStatus("Your session ended. Sign in again to continue.");
        setTone("info");
        return;
      }
      setStatus(friendlyError(error, message));
      setTone("error");
    },
    [signedOut],
  );

  const loadBalance = useCallback(async (address: string) => {
    try {
      setBalance(await readSettlementBalance(getAddress(address)));
      setBalanceUnavailable(false);
    } catch {
      setBalanceUnavailable(true);
    }
  }, []);

  const loadFirstPages = useCallback(async () => {
    const [nextActivity, nextReserves] = await Promise.all([
      authorized(`/v1/accounts/me/activity?limit=${ACTIVITY_PAGE}`) as Promise<
        Page<ActivityItem, ActivityCursor>
      >,
      authorized(`/v1/accounts/me/reserves?limit=${RESERVE_PAGE}`) as Promise<
        Page<ReserveBalance, ReserveCursor>
      >,
    ]);
    setActivity(nextActivity);
    setReserves(nextReserves);
  }, [authorized]);

  // Load the wallet whenever a session is present, including after returning from another page.
  useEffect(() => {
    if (!session) return;
    void loadBalance(session.account);
    loadFirstPages().catch((error) => failed(error, "Activity is temporarily unavailable."));
  }, [session, loadBalance, loadFirstPages, failed]);

  // Deadlines move from "spend until" to "comes back from" on their own; a coarse tick is enough
  // because the copy shows minutes.
  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1_000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  async function relayerRequest(path: string, init: RequestInit) {
    const relayer = process.env.NEXT_PUBLIC_RELAYER_URL;
    if (!relayer) throw new Error("The payment service is not configured.");
    const response = await fetch(`${relayer}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { action?: string } | null;
      throw new Error(body?.action ?? "The return is unavailable right now. Try again shortly.");
    }
    return response.json();
  }

  // A return is final only once the network confirms it; poll until then, then reload the row.
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
          if (next.state === "FINALIZED") {
            await Promise.all([loadFirstPages(), loadBalance(session.account)]);
            report("Returned. The money is back in your balance.", "success");
          }
        } catch {
          // A transient status failure leaves the return in place; the next tick asks again.
        }
      }
    }, 3_000);
    return () => clearTimeout(timer);
  });

  async function copyAddress() {
    await navigator.clipboard.writeText(account);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  async function signIn() {
    setBusy(true);
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
      report("");
      signedIn({
        account: verified.account,
        sessionToken: verified.sessionToken,
        credentialId: assertion.id,
      });
    } catch (error) {
      report(
        error instanceof SessionEnded
          ? "That passkey was not accepted. Try again, or create an account."
          : passkeyErrorMessage(error, "Sign-in failed. Try again."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!session) return;
    setBusy(true);
    try {
      await Promise.all([loadFirstPages(), loadBalance(session.account)]);
      report("");
    } catch (error) {
      failed(error, "Activity is temporarily unavailable. Your account is unchanged.");
    } finally {
      setBusy(false);
    }
  }

  async function moreActivity() {
    const cursor = activity?.nextCursor;
    if (!cursor) return;
    setLoadingMore("activity");
    try {
      const next = (await authorized(
        `/v1/accounts/me/activity?limit=${ACTIVITY_PAGE}&beforeBlock=${cursor.blockNumber}&beforeTransitionId=${encodeURIComponent(cursor.transitionId)}`,
      )) as Page<ActivityItem, ActivityCursor>;
      setActivity((current) => ({
        items: [...(current?.items ?? []), ...next.items],
        nextCursor: next.nextCursor,
      }));
    } catch (error) {
      failed(error, "More activity is unavailable right now.");
    } finally {
      setLoadingMore(undefined);
    }
  }

  async function moreReserves() {
    const cursor = reserves?.nextCursor;
    if (!cursor) return;
    setLoadingMore("reserves");
    try {
      const next = (await authorized(
        `/v1/accounts/me/reserves?limit=${RESERVE_PAGE}&beforeOpenedBlock=${cursor.openedBlock}&beforeChannelId=${cursor.channelId}`,
      )) as Page<ReserveBalance, ReserveCursor>;
      setReserves((current) => ({
        items: [...(current?.items ?? []), ...next.items],
        nextCursor: next.nextCursor,
      }));
    } catch (error) {
      failed(error, "More reserves are unavailable right now.");
    } finally {
      setLoadingMore(undefined);
    }
  }

  async function signOut() {
    if (!session) return;
    setBusy(true);
    try {
      await request("/v1/accounts/sessions/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      }).catch((error) => {
        // An already-ended session is signed out either way.
        if (!(error instanceof SessionEnded)) throw error;
      });
      signedOut();
      setActivity(undefined);
      setReserves(undefined);
      setReturns({});
      setBalance(undefined);
      setFunding(undefined);
      report("Signed out.");
    } catch (error) {
      report(friendlyError(error, "Sign out failed. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function returnReserve(reserve: ReserveBalance) {
    // Only the tapped reserve shows progress; the others stay usable.
    setReturning(reserve.channelId);
    try {
      // A return needs no session: the vault pays only this account, so the relayer accepts it
      // from anyone and keeps one live return per balance.
      const result = (await relayerRequest(`/v1/reserve-channels/${reserve.channelId}/reclaims`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: reserve.eventId }),
      })) as ReturnOperation;
      setReturns((current) => ({ ...current, [reserve.channelId]: result }));
      report("Return started. It shows here once the network confirms it.", "success");
    } catch (error) {
      report(friendlyError(error, "The return was not accepted."), "error");
    } finally {
      setReturning(undefined);
    }
  }

  async function fundTestBalance() {
    if (!session || !api) return;
    const units = toBaseUnits(fundAmount, SETTLEMENT_ASSET.decimals);
    if (!units) {
      report("Choose a test amount.", "error");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${api}/v1/funding/faucet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.sessionToken}`,
        },
        body: JSON.stringify({ amount: units }),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401) throw new SessionEnded();
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        const messages: Record<string, string> = {
          faucet_exhausted: "The test faucet has reached its daily limit. Try again tomorrow.",
          faucet_account_limit: "This account has already received its share of test money.",
          faucet_depleted: "The test faucet is out of funds. Try again later.",
          faucet_rejected: "That amount is above the per-request test limit. Choose less.",
        };
        throw new Error(messages[body?.error ?? ""] ?? "Test money is unavailable right now.");
      }
      const result = (await response.json()) as { transactionHash: string };
      setFunding(result.transactionHash);
      await Promise.all([loadBalance(session.account), loadFirstPages()]);
      report(`Added ${fundAmount} test ${SETTLEMENT_ASSET.symbol}.`, "success");
    } catch (error) {
      failed(error, "Test money is unavailable right now.");
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
      <main className="with-tabbar">
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
        <AttendeeNav />
      </main>
    );

  const activityItems = activity?.items ?? [];
  const reserveItems = reserves?.items ?? [];

  return (
    <main className="with-tabbar">
      <section className="shell narrow account-shell">
        <div className="account-header">
          <div className="identity">
            <span className="avatar" aria-hidden="true">
              OB
            </span>
            <div>
              <small>Your account · test network</small>
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
          <div className="balance-top">
            <span>Available balance</span>
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              onClick={refresh}
              aria-label="Refresh balance and activity"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <strong>
            {balance !== undefined
              ? `${formatAmount(balance)} ${SETTLEMENT_ASSET.symbol}`
              : balanceUnavailable
                ? "Unavailable"
                : "…"}
          </strong>
          <small>Test {SETTLEMENT_ASSET.symbol}, read straight from the network.</small>
        </div>

        {notice}

        <section className="card" aria-labelledby="funding-heading">
          <div className="section-heading">
            <h2 id="funding-heading">Add test money</h2>
            <p>Not real money</p>
          </div>
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
                {value} {SETTLEMENT_ASSET.symbol}
              </button>
            ))}
          </fieldset>
          <button type="button" className="block-button" disabled={busy} onClick={fundTestBalance}>
            {busy ? "Working…" : `Add ${fundAmount} ${SETTLEMENT_ASSET.symbol}`}
          </button>
          {funding && (
            <a className="inline-proof" href={explorerTx(funding)} target="_blank" rel="noreferrer">
              View on explorer
            </a>
          )}
        </section>

        <OpenReserve
          identity={{
            account: getAddress(account),
            credentialId: session.credentialId,
            sessionToken: session.sessionToken,
          }}
          disabled={busy}
          onOpened={async () => {
            await Promise.all([loadFirstPages(), loadBalance(account)]).catch(() => undefined);
          }}
        />

        <section className="activity" aria-labelledby="balances-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">For when the network drops</p>
              <h2 id="balances-heading">Offline reserves</h2>
            </div>
            <Link className="text-button" href="/offline">
              Pay offline
            </Link>
          </div>
          {!reserves ? (
            <p className="empty-state">Loading…</p>
          ) : (
            <ReserveBalances
              reserves={reserveItems}
              vendors={vendors}
              operations={returns}
              nowSeconds={nowSeconds}
              busy={busy}
              returning={returning}
              onReturn={returnReserve}
            />
          )}
          {reserves?.nextCursor && (
            <button
              type="button"
              className="secondary-button block-button"
              disabled={loadingMore === "reserves"}
              onClick={moreReserves}
            >
              {loadingMore === "reserves" ? "Loading…" : "Show older reserves"}
            </button>
          )}
        </section>

        <section className="activity" aria-labelledby="activity-heading">
          <div className="section-heading">
            <h2 id="activity-heading">Activity</h2>
            {activityItems.length > 0 && (
              <p>
                {activityItems.length}
                {activity?.nextCursor ? "+" : ""} shown
              </p>
            )}
          </div>
          {!activity ? (
            <p className="empty-state">Loading…</p>
          ) : (
            <ActivityList items={activityItems} vendors={vendors} />
          )}
          {activity?.nextCursor && (
            <button
              type="button"
              className="secondary-button block-button"
              disabled={loadingMore === "activity"}
              onClick={moreActivity}
            >
              {loadingMore === "activity" ? "Loading…" : "Show older activity"}
            </button>
          )}
        </section>
      </section>
      <AttendeeNav />
    </main>
  );
}
