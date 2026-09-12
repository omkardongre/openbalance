"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";

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

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export default function AccountPage() {
  const [account, setAccount] = useState("");
  const [session, setSession] = useState<string>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity>();
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

  async function loadActivity(sessionToken: string) {
    const result = (await request("/v1/accounts/me/activity?limit=25", {
      method: "GET",
      headers: { Authorization: `Bearer ${sessionToken}` },
    })) as Activity;
    setActivity(result);
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
      setStatus("Session revoked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign out failed.");
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
      </section>
    </main>
  );
}
