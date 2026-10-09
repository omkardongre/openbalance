"use client";

import { accountFactoryAbi } from "@openbalance/protocol";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import Link from "next/link";
import { useEffect, useState } from "react";
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

/** Pause between automatic account status checks while the network finalizes it. */
const FINALITY_POLL_MS = 3_000;

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
      if (!relayer) throw new Error("Account setup is unavailable right now. Try again later.");
      const response = await fetch(`${relayer}/v1/accounts/deployments/sponsor`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ token }),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Account setup is busy. Try again in a moment.");
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
        report("Your account is ready.", "success");
      } else {
        report("Creating your account. This usually takes a few seconds.", "info");
      }
    } catch (error) {
      report(
        passkeyErrorMessage(
          error,
          "Account setup is busy. Your passkey is safe; try again in a moment.",
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
        throw new Error("Something did not match your passkey. Start again.");
      setDeployment(result);
      setAccountAddress(result.account);
      if (result.status === "confirmed") {
        setConfirmed(true);
        report("Your account is ready.", "success");
        return;
      }
      if (submit) {
        const provider = (
          window as unknown as {
            ethereum?: { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
          }
        ).ethereum;
        if (!provider) throw new Error("No browser wallet found.");
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
        report("Your account is ready.", "success");
      } else {
        report("Creating your account. This usually takes a few seconds.", "info");
      }
    } catch (error) {
      report(
        passkeyErrorMessage(error, "We could not confirm your account yet. Tap Check now."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  // An account was submitted but is not final yet: offer a status check instead of another submit.
  const awaitingFinality = !confirmed && (Boolean(accountAddress) || submitted);

  // Finality takes a few seconds on the network; check by itself instead of asking the person to
  // keep tapping. The button stays as a manual fallback.
  useEffect(() => {
    // Stop on an error so a lasting failure is shown, not retried in a loop; "Check now" resumes.
    if (!awaitingFinality || busy || tone === "error") return;
    const timer = setTimeout(() => void deploy(false), FINALITY_POLL_MS);
    return () => clearTimeout(timer);
  });

  // Each step is a new screen; start it at the top so the header and progress are visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step change only.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

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
              We set up your account for free. Only your passkey can use it, so keep it on this
              phone.
            </p>
            {awaitingFinality ? (
              <button
                type="button"
                className="block-button"
                disabled={busy}
                onClick={() => deploy(false)}
              >
                {busy ? "Creating your account…" : "Check now"}
              </button>
            ) : (
              <button type="button" className="block-button" disabled={busy} onClick={sponsor}>
                {busy ? "Creating your account…" : "Create my account"}
              </button>
            )}
            <details>
              <summary>Advanced: use my own browser wallet</summary>
              <p className="fine-print">
                For people who already use a crypto wallet. You pay a small test-network fee.
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || submitted}
                onClick={() => deploy(true)}
              >
                Set up with my wallet
              </button>
              {submitted && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setSubmitted(false);
                    report("Trying again may charge another small fee. Check your wallet first.");
                  }}
                >
                  Try again
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
              Keep the passkey on this phone. For now it is the only way into your account.
            </p>
          </section>
        )}

        <p role="status" aria-live="polite" className={`notice ${tone === "info" ? "" : tone}`}>
          {status}
        </p>
      </section>
    </main>
  );
}
