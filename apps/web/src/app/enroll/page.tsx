"use client";

import { accountFactoryAbi } from "@openbalance/protocol";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import Link from "next/link";
import { useState } from "react";
import {
  type Address,
  encodeFunctionData,
  type Hex,
  sha256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { passkeyErrorMessage, shortAddress } from "../../lib/account-display";
import { BrandMark } from "../brand-mark";

type Enrollment = { publicKey: { x: Hex; y: Hex }; rpId: string; origin: string };
type Deployment = {
  account: Address;
  status: "pending" | "confirmed";
  transaction: { to: Address; data: Hex; value: "0x0"; chainId: Hex };
  parameters: { salt: Hex };
  manifest: { chainId: number; factory: Address };
};
async function post(path: string, body: unknown, headers?: Record<string, string>) {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) throw new Error("Enrollment service is not configured.");
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 503
        ? "Service unavailable. Retry checking the same account."
        : "The request could not be verified. Your existing account has not been changed.",
    );
  return response.json();
}

type Tone = "info" | "success" | "error";

const STEPS = ["Passkey", "Account", "Done"] as const;

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="m10.85 12.15 8.65-8.65M18 5l2 2M15 8l2 2" strokeLinecap="round" />
    </svg>
  );
}

function ChainIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="3" />
      <path d="M8 7V5a4 4 0 0 1 8 0v2M12 12v3" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function EnrollPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<Tone>("info");
  const [record, setRecord] = useState<string>();
  const [token, setToken] = useState<string>();
  const [verifiedKey, setVerifiedKey] = useState<Enrollment>();
  const [, setDeployment] = useState<Deployment>();
  // Sponsorship answers with the account address; keep it even before a prepared deployment exists.
  const [accountAddress, setAccountAddress] = useState<Address>();
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [sponsorshipKey, setSponsorshipKey] = useState<string>();
  const [copied, setCopied] = useState(false);
  const step = !token ? 0 : confirmed ? 2 : 1;

  function report(message: string, nextTone: Tone = "info") {
    setStatus(message);
    setTone(nextTone);
  }

  async function copyAddress() {
    if (!accountAddress) return;
    await navigator.clipboard.writeText(accountAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  async function enroll() {
    setBusy(true);
    setRecord(undefined);
    setToken(undefined);
    setVerifiedKey(undefined);
    setDeployment(undefined);
    setAccountAddress(undefined);
    setConfirmed(false);
    setSubmitted(false);
    setSponsorshipKey(undefined);
    report("Create your passkey, then confirm it once more.");
    try {
      const start = await post("/v1/accounts/enrollment-challenges", {});
      const registered = await startRegistration({ optionsJSON: start.options });
      const proof = await post("/v1/accounts/enrollments/register", {
        token: start.token,
        response: registered,
      });
      const signed = await startAuthentication({ optionsJSON: proof.options });
      const verified = await post("/v1/accounts/enrollments/prove", {
        token: start.token,
        response: signed,
      });
      if (verified.status !== "verified") throw new Error("Passkey verification incomplete.");
      setRecord(JSON.stringify(verified, null, 2));
      setToken(start.token);
      setVerifiedKey(verified);
      report("Passkey verified.", "success");
    } catch (error) {
      report(passkeyErrorMessage(error, "Passkey creation failed. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }
  async function sponsor() {
    if (!token) return;
    setBusy(true);
    const key = sponsorshipKey ?? `account-deployment:${crypto.randomUUID()}`;
    setSponsorshipKey(key);
    try {
      const relayer = process.env.NEXT_PUBLIC_RELAYER_URL;
      if (!relayer) throw new Error("Account sponsorship is not configured.");
      const response = await fetch(`${relayer}/v1/accounts/deployments/sponsor`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ token }),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error("Sponsorship is unavailable. Retry the same request later.");
      const result = await response.json();
      setAccountAddress(result.account);
      setDeployment((current) =>
        current
          ? {
              ...current,
              account: result.account,
              status: result.status === "confirmed" ? "confirmed" : "pending",
            }
          : current,
      );
      if (result.status === "confirmed") {
        setConfirmed(true);
        report("Your account is live on Monad testnet.", "success");
      } else {
        report(
          "Account submitted. The network is finalizing it; check again in a few seconds.",
          "info",
        );
      }
    } catch (error) {
      report(
        passkeyErrorMessage(
          error,
          "Sponsorship is unavailable. Your passkey and account parameters are unchanged.",
        ),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  async function deploy(submit: boolean) {
    if (!token || !verifiedKey) return;
    setBusy(true);
    try {
      const result: Deployment = await post("/v1/accounts/deployments/prepare", { token });
      const owners = {
        primary: verifiedKey.publicKey,
        backup: { x: zeroHash, y: zeroHash },
        recovery: zeroAddress,
      };
      const expected = encodeFunctionData({
        abi: accountFactoryAbi,
        functionName: "create",
        args: [
          owners,
          sha256(stringToHex(verifiedKey.rpId)),
          verifiedKey.origin,
          result.parameters.salt,
        ],
      });
      if (
        ![31337, 10143].includes(result.manifest.chainId) ||
        result.transaction.chainId !== `0x${result.manifest.chainId.toString(16)}` ||
        result.transaction.to !== result.manifest.factory ||
        result.transaction.value !== "0x0" ||
        expected !== result.transaction.data ||
        verifiedKey.origin !== window.location.origin
      )
        throw new Error("Deployment parameters do not match your verified passkey.");
      setDeployment(result);
      setAccountAddress(result.account);
      if (result.status === "confirmed") {
        setConfirmed(true);
        report("Your account is live on Monad testnet.", "success");
        return;
      }
      if (submit) {
        const provider = (
          window as unknown as {
            ethereum?: { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
          }
        ).ethereum;
        if (!provider)
          throw new Error("A connected test wallet is required to pay the deployment network fee.");
        const addresses = await provider.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(addresses) || !/^0x[0-9a-fA-F]{40}$/.test(addresses[0]))
          throw new Error("No wallet account available.");
        if ((await provider.request({ method: "eth_chainId" })) !== result.transaction.chainId)
          throw new Error(`Switch your test wallet to chain ${result.manifest.chainId}.`);
        setSubmitted(true);
        await provider.request({
          method: "eth_sendTransaction",
          params: [{ ...result.transaction, from: addresses[0] }],
        });
      }
      const observation: Deployment = await post("/v1/accounts/deployments/confirm", { token });
      setDeployment(observation);
      setAccountAddress(observation.account);
      if (observation.status === "confirmed") {
        setConfirmed(true);
        report("Your account is live on Monad testnet.", "success");
      } else {
        report("Still finalizing on the network. Check again in a few seconds.", "info");
      }
    } catch (error) {
      report(
        passkeyErrorMessage(
          error,
          "Deployment could not be verified. Check the same account before retrying.",
        ),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  // An account was submitted but is not final yet: offer a status check instead of another submit.
  const awaitingFinality = !confirmed && (Boolean(accountAddress) || submitted);
  return (
    <main>
      <section className="shell narrow">
        <div className="brand-bar">
          <BrandMark />
          <Link className="text-button" href="/account">
            Sign in
          </Link>
        </div>
        <ol className="steps" aria-label="Account setup progress">
          {STEPS.map((label, index) => (
            <li
              key={label}
              data-state={index < step ? "done" : index === step ? "current" : "upcoming"}
              aria-current={index === step ? "step" : undefined}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section aria-labelledby="step-passkey">
            <div className="step-icon">
              <KeyIcon />
            </div>
            <h1 id="step-passkey">Create your account</h1>
            <p className="summary">
              Your device&apos;s passkey is your key. No seed phrase, no password. Confirm with your
              fingerprint or face, then once more to prove it works.
            </p>
            <button type="button" className="block-button" disabled={busy} onClick={enroll}>
              {busy ? "Waiting for your passkey…" : "Create passkey"}
            </button>
            <p className="fine-print">
              Already have one? <Link href="/account">Sign in</Link>
            </p>
          </section>
        )}

        {step === 1 && (
          <section aria-labelledby="step-account">
            <div className="step-icon">
              <ChainIcon />
            </div>
            <h1 id="step-account">Set up your account</h1>
            <p className="summary">
              We create your smart account on Monad testnet and pay the one-time network fee. Only
              your passkey can control it.
            </p>
            {awaitingFinality ? (
              <button
                type="button"
                className="block-button"
                disabled={busy}
                onClick={() => deploy(false)}
              >
                {busy ? "Checking…" : "Check status"}
              </button>
            ) : (
              <button type="button" className="block-button" disabled={busy} onClick={sponsor}>
                {busy ? "Creating your account…" : "Create my account"}
              </button>
            )}
            <details>
              <summary>Advanced: pay the fee from your own test wallet</summary>
              <p className="fine-print">
                Uses a connected browser wallet on Monad testnet instead of sponsorship.
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || submitted}
                onClick={() => deploy(true)}
              >
                Deploy with my wallet
              </button>
              {submitted && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setSubmitted(false);
                    report(
                      "Retry uses the same account and may incur another network fee. Check your wallet activity first.",
                    );
                  }}
                >
                  Enable retry for the same account
                </button>
              )}
            </details>
          </section>
        )}

        {step === 2 && accountAddress && (
          <section aria-labelledby="step-done">
            <div className="step-icon">
              <CheckIcon />
            </div>
            <h1 id="step-done">You&apos;re all set</h1>
            <p className="summary">Your account is live. Add test money and start paying.</p>
            <div className="card">
              <p className="eyebrow">Your account</p>
              <div className="section-heading">
                <code title={accountAddress}>{shortAddress(accountAddress)}</code>
                <button type="button" className="text-button" onClick={copyAddress}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <Link className="primary-action block-button" href="/account">
              Go to my account
            </Link>
            <p className="fine-print">
              Backup and recovery are not set up yet, so keep the passkey on this device.
            </p>
          </section>
        )}

        <p role="status" aria-live="polite" className={`notice ${tone === "info" ? "" : tone}`}>
          {status}
        </p>

        {record && (
          <details>
            <summary>Public enrollment record</summary>
            <pre>{record}</pre>
          </details>
        )}
      </section>
    </main>
  );
}
