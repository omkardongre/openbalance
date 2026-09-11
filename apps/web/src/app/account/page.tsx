"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";

const accountPattern = /^0x[0-9a-fA-F]{40}$/;

export default function AccountPage() {
  const [account, setAccount] = useState("");
  const [session, setSession] = useState<string>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
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
      setStatus("Account access verified with your passkey.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Authentication failed.");
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
      setStatus("Session revoked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign out failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="shell">
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
          <button type="button" disabled={busy} onClick={signOut}>
            Sign out
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={signIn}>
            {busy ? "Verifying…" : "Continue with passkey"}
          </button>
        )}
        <p role="status">{status}</p>
      </section>
    </main>
  );
}
