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
import { BrandMark } from "../brand-mark";
import { useOnline } from "../offline-shell";
import { useSession } from "../session-provider";
import { type ActivityItem, ActivityList } from "./activity-list";
import { OfflinePending } from "./offline-pending";
import { OpenReserve } from "./open-reserve";
import { type ReserveBalance, ReserveBalances, type ReturnOperation } from "./reserve-balances";

type Page<T, C> = { items: T[]; nextCursor: C | null };
type ActivityCursor = { blockNumber: string; transitionId: string };
type ReserveCursor = { openedBlock: string; channelId: string };

/** Rows per page; small enough that a phone shows a page without endless scrolling. */
const ACTIVITY_PAGE = 10;
/** Payments shown before the customer asks for more. */
const ACTIVITY_PREVIEW = 3;
/** Reserves last a few hours, so one page this size always holds every one still open. */
const RESERVE_PAGE = 20;
/** After setting money aside, how often and how long to look for it while the network records it. */
const NEW_RESERVE_POLL_MS = 3_000;
const NEW_RESERVE_POLL_TRIES = 20;
/** Success notes clear themselves; what they confirm is visible on the page. */
const SUCCESS_NOTICE_MS = 5_000;

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
  const online = useOnline();
  // Venue Wi-Fi can look connected while passing nothing; a sign-in that cannot reach the server
  // counts as no signal too.
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!online) setUnreachable(false);
  }, [online]);
  const account = session?.account ?? "";
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  const [busy, setBusy] = useState(false);
  /** The reserve whose return is being sent, so only its button shows progress. */
  const [returning, setReturning] = useState<string>();
  const [activity, setActivity] = useState<Page<ActivityItem, ActivityCursor>>();
  const [reserves, setReserves] = useState<Page<ReserveBalance, ReserveCursor>>();
  const [activityShown, setActivityShown] = useState(ACTIVITY_PREVIEW);
  const [loadingMore, setLoadingMore] = useState<"activity">();
  /** A reserve just set aside that the list does not show yet, and how many looks are left. */
  const [awaiting, setAwaiting] = useState<{ channelId: string; tries: number }>();
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

  const loadReserves = useCallback(async () => {
    setReserves(
      (await authorized(`/v1/accounts/me/reserves?limit=${RESERVE_PAGE}`)) as Page<
        ReserveBalance,
        ReserveCursor
      >,
    );
  }, [authorized]);

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

  // The balance keeps itself current: a light read every 15 s, and a full reload whenever the
  // customer comes back to the tab (after paying at a stall, for example).
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void loadBalance(session.account);
      loadReserves().catch(() => undefined);
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void loadBalance(session.account);
      loadFirstPages().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [session, loadBalance, loadFirstPages, loadReserves]);

  // The network records a new reserve a few seconds after it is final, so a single read right
  // after setting it aside can miss it. Keep looking briefly; no page reload is ever needed.
  useEffect(() => {
    if (!awaiting || !session) return;
    if (reserves?.items.some((item) => item.channelId.toLowerCase() === awaiting.channelId)) {
      setAwaiting(undefined);
      return;
    }
    if (awaiting.tries <= 0) {
      setAwaiting(undefined);
      return;
    }
    const timer = setTimeout(() => {
      loadReserves()
        .catch(() => undefined)
        .finally(() =>
          setAwaiting((current) => current && { ...current, tries: current.tries - 1 }),
        );
    }, NEW_RESERVE_POLL_MS);
    return () => clearTimeout(timer);
  }, [awaiting, reserves, session, loadReserves]);

  useEffect(() => {
    if (tone !== "success" || !status) return;
    const timer = setTimeout(() => setStatus(""), SUCCESS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [tone, status]);

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
      // fetch rejects with a TypeError only when no response arrived at all.
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError")
      ) {
        setUnreachable(true);
        return;
      }
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

  async function showMoreActivity() {
    const loaded = activity?.items.length ?? 0;
    // Reveal what is already loaded first; fetch the next page only when that runs out.
    if (loaded > activityShown) {
      setActivityShown((count) => count + ACTIVITY_PAGE);
      return;
    }
    const cursor = activity?.nextCursor;
    if (!cursor) return;
    setActivityShown((count) => count + ACTIVITY_PAGE);
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

  // Signing in needs the server. With no signal the Wallet points to the one thing that works.
  if (!session && (!online || unreachable))
    return (
      <main>
        <section className="shell narrow">
          <div className="brand-bar">
            <BrandMark />
          </div>
          <h1>No signal</h1>
          <p className="summary">
            You can still pay a stall from the money you set aside. Your wallet comes back when you
            are online again.
          </p>
          {/* A full page load, so the saved offline copy answers even with no network. */}
          <a className="primary-action block-button" href="/offline">
            Pay offline
          </a>
          {online && (
            <button
              type="button"
              className="secondary-button block-button"
              onClick={() => setUnreachable(false)}
            >
              Try signing in again
            </button>
          )}
        </section>
      </main>
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

  const activityItems = activity?.items ?? [];
  const reserveItems = reserves?.items ?? [];

  return (
    <main>
      <section className="shell narrow account-shell">
        <div className="account-header">
          <BrandMark />
          {/* Account details and sign-out are rarely needed, so they sit behind one small menu. */}
          <details className="account-menu">
            <summary aria-label="Account menu">
              <span aria-hidden="true">⋯</span>
            </summary>
            <div className="account-menu-panel">
              <small>Account</small>
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
              <button
                type="button"
                className="secondary-button block-button"
                disabled={busy}
                onClick={signOut}
              >
                Sign out
              </button>
            </div>
          </details>
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
        </div>

        <Link className="primary-action block-button scan-button" href="/offline?scan=1">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
          </svg>
          Scan to pay
        </Link>

        {status && notice}

        <OpenReserve
          identity={{
            account: getAddress(account),
            credentialId: session.credentialId,
            sessionToken: session.sessionToken,
          }}
          disabled={busy}
          onOpened={async (channelId) => {
            setAwaiting({ channelId: channelId.toLowerCase(), tries: NEW_RESERVE_POLL_TRIES });
            await Promise.all([loadFirstPages(), loadBalance(account)]).catch(() => undefined);
          }}
        >
          <ReserveBalances
            reserves={reserveItems}
            vendors={vendors}
            operations={returns}
            nowSeconds={nowSeconds}
            busy={busy}
            returning={returning}
            onReturn={returnReserve}
          />
        </OpenReserve>

        {/* Demo only. Open by itself while the balance is empty, otherwise one quiet line. */}
        <details
          className="card test-money"
          key={balance === 0n ? "empty" : "funded"}
          open={balance === 0n || undefined}
        >
          <summary>Add test money</summary>
          <p className="muted">Not real money.</p>
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
        </details>

        {/* History is rarely needed: one closed row, last, that opens on the latest few payments. */}
        <details className="card activity">
          <summary>Recent payments</summary>
          <OfflinePending online={online} />
          {!activity ? (
            <p className="empty-state">Loading…</p>
          ) : (
            <ActivityList items={activityItems.slice(0, activityShown)} vendors={vendors} />
          )}
          <div className="show-row">
            {(activityItems.length > activityShown || activity?.nextCursor) && (
              <button
                type="button"
                className="text-button show-toggle"
                disabled={loadingMore === "activity"}
                onClick={showMoreActivity}
              >
                {loadingMore === "activity" ? "Loading…" : "Show more"}
              </button>
            )}
            {activityShown > ACTIVITY_PREVIEW && activityItems.length > ACTIVITY_PREVIEW && (
              <button
                type="button"
                className="text-button show-toggle"
                onClick={() => setActivityShown(ACTIVITY_PREVIEW)}
              >
                Show less
              </button>
            )}
          </div>
        </details>
      </section>
    </main>
  );
}
