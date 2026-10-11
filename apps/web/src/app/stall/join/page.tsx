"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, getAddress, type Hex, isAddress } from "viem";
import {
  connectedAccount,
  ensureChain,
  injectedWallet,
  shortAddress,
} from "../../../lib/organizer-wallet";
import { terminalSetupPayload } from "../../../lib/terminal-setup";
import { BrandMark } from "../../brand-mark";
import { PhoneSetupSteps } from "../../phone-setup-steps";

type Invite = {
  state: "INVITED";
  label: string;
  expiresAt: string;
  chainId: number;
  registry: `0x${string}`;
  vendorId: Hex;
  destinationVersion: string;
  assetSymbol: string;
  categories: string[];
};

/** After submitting, the same link shows where the stall stands. */
type Standing = {
  state: "SUBMITTED" | "DECLINED" | "APPROVED" | "LIVE";
  stallName: string | null;
  pairing: "NEEDS_PHONE" | "CHECKED_IN" | null;
};

type Phase = "loading" | "invalid" | "form" | "status";

/** The status page re-reads itself while open; the invite routes allow 10 calls a minute. */
const STATUS_REFRESH_MS = 15_000;

/** Owner approval stays valid for a week, enough for the organizer to review it. */
const APPROVAL_SECONDS = 7 * 24 * 60 * 60;

export default function JoinStallPage() {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<Invite>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [stallName, setStallName] = useState("");
  const [category, setCategory] = useState("Food");
  const [account, setAccount] = useState<`0x${string}`>();
  const [separatePayout, setSeparatePayout] = useState(false);
  const [payout, setPayout] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [standing, setStanding] = useState<Standing>();
  const [setupImage, setSetupImage] = useState<string>();

  const lookup = useCallback(
    async (secret: string) => {
      const response = await fetch(`${api}/v1/stall-invites/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: secret }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) {
        setPhase("invalid");
        return;
      }
      if (!response.ok) throw new Error("Could not load your stall. Try again in a moment.");
      const found = (await response.json()) as Invite | Standing;
      if (found.state === "INVITED") {
        setInvite(found);
        setPhase("form");
        return;
      }
      setStanding(found);
      // The code is only useful until the phone checks in with it.
      if (found.pairing !== "NEEDS_PHONE") setSetupImage(undefined);
      setPhase("status");
    },
    [api],
  );

  useEffect(() => {
    // The invite secret lives in the URL fragment, which browsers never send to a server. The owner
    // keeps the same link: before submitting it is the form, afterwards their stall's status page.
    const secret = window.location.hash.replace(/^#/, "");
    setToken(secret);
    if (!api || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      setPhase("invalid");
      return;
    }
    lookup(secret).catch(() => setPhase("invalid"));
  }, [api, lookup]);

  // Keep the status page current while it is visible: review, phone check-in, go-live.
  const settled = standing?.state === "LIVE" && standing.pairing === null;
  useEffect(() => {
    if (phase !== "status" || settled || standing?.state === "DECLINED" || !token) return;
    const tick = () => {
      if (document.visibilityState === "visible") lookup(token).catch(() => undefined);
    };
    const timer = setInterval(tick, STATUS_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [phase, settled, standing?.state, token, lookup]);

  async function showSetupCode() {
    if (!api) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${api}/v1/stall-invites/setup-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await lookup(token).catch(() => undefined);
        throw new Error("A setup code is not available right now. Try again in a moment.");
      }
      const issued = (await response.json()) as { accessToken: string };
      setSetupImage(
        await QRCode.toDataURL(terminalSetupPayload(issued.accessToken), {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 360,
        }),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    setMessage("");
    try {
      const wallet = injectedWallet();
      setAccount(await connectedAccount(wallet));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect your wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!invite || !api) return;
    setMessage("");
    const name = stallName.trim();
    if (name.length < 2 || name.length > 60) {
      setMessage("Enter your stall name (2 to 60 characters).");
      return;
    }
    if (!account) {
      setMessage("Connect your wallet first.");
      return;
    }
    const destination = separatePayout ? payout.trim() : account;
    if (!isAddress(destination)) {
      setMessage("Enter a valid payout address (it starts with 0x).");
      return;
    }
    setBusy(true);
    try {
      const wallet = injectedWallet();
      await ensureChain(wallet, invite.chainId);
      const signer = await connectedAccount(wallet);
      if (signer !== account) setAccount(signer);
      const deadline = BigInt(Math.floor(Date.now() / 1_000) + APPROVAL_SECONDS);
      const client = createWalletClient({ transport: custom(wallet) });
      const signature = await client.signTypedData({
        account: signer,
        domain: {
          name: "OpenBalanceEventRegistry",
          version: "1",
          chainId: invite.chainId,
          verifyingContract: getAddress(invite.registry),
        },
        types: {
          DestinationApproval: [
            { name: "vendorId", type: "bytes32" },
            { name: "version", type: "uint256" },
            { name: "destination", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "DestinationApproval",
        message: {
          vendorId: invite.vendorId,
          version: BigInt(invite.destinationVersion),
          destination: getAddress(destination),
          deadline,
        },
      });
      const response = await fetch(`${api}/v1/stall-invites/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          stallName: name,
          category,
          authority: signer,
          payoutAddress: getAddress(destination),
          deadline: deadline.toString(),
          signature,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) {
        setPhase("invalid");
        return;
      }
      if (!response.ok)
        throw new Error("Your details were not accepted. Check them and try again.");
      setMessage("");
      // The link stays in the address bar on purpose: it is now this stall's status page.
      await lookup(token).catch(() =>
        setStanding({ state: "SUBMITTED", stallName: name, pairing: null }),
      );
      setPhase("status");
    } catch (error) {
      const code = (error as { code?: number }).code;
      setMessage(
        code === 4001
          ? "You cancelled the request in your wallet. Nothing was sent."
          : error instanceof Error
            ? error.message
            : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="shell narrow">
        <div className="brand-bar">
          <BrandMark />
        </div>
        {phase === "loading" && <p className="muted">Opening your invite…</p>}

        {phase === "invalid" && (
          <>
            <p className="eyebrow">Stall invite</p>
            <h1>This invite link no longer works</h1>
            <p className="muted">
              It may have expired or already been used. Ask the event organizer to send you a new
              link.
            </p>
          </>
        )}

        {phase === "form" && invite && (
          <>
            <p className="eyebrow">Join the event as a stall</p>
            <h1>Set up your stall</h1>
            <p className="muted">
              The organizer invited <strong>{invite.label}</strong>. Tell us how customers will see
              your stall and where your earnings should go.
            </p>

            <label>
              Stall name
              <input
                value={stallName}
                maxLength={60}
                autoComplete="organization"
                placeholder="For example: Taco Truck"
                disabled={busy}
                onChange={(event) => setStallName(event.target.value)}
              />
            </label>
            <label>
              What you sell
              <select
                value={category}
                disabled={busy}
                onChange={(event) => setCategory(event.target.value)}
              >
                {invite.categories.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>

            <div className="card">
              <h2>Your wallet</h2>
              <p className="muted">
                Your wallet confirms you own this stall. Earnings go to it unless you choose another
                address.
              </p>
              {account ? (
                <p>
                  Connected: <strong>{shortAddress(account)}</strong>
                </p>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={connect}
                >
                  Connect wallet
                </button>
              )}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={separatePayout}
                  disabled={busy}
                  onChange={(event) => setSeparatePayout(event.target.checked)}
                />
                Send earnings to a different address
              </label>
              {separatePayout && (
                <label>
                  Payout address
                  <input
                    value={payout}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="0x…"
                    disabled={busy}
                    onChange={(event) => setPayout(event.target.value)}
                  />
                </label>
              )}
            </div>

            <button type="button" className="block-button" disabled={busy} onClick={submit}>
              {busy ? "Approve in your wallet…" : "Approve and send to organizer"}
            </button>
            <p className="fine-print">Free. No money moves.</p>
            {message && (
              <p role="alert" className="notice error">
                {message}
              </p>
            )}
          </>
        )}

        {phase === "status" && standing && (
          <>
            {standing.state === "SUBMITTED" && (
              <>
                <p className="eyebrow">Sent</p>
                <h1>You're on the list</h1>
                <p className="muted">
                  The organizer is reviewing <strong>{standing.stallName}</strong>. Keep this link:
                  it shows your next step, and this page updates by itself.
                </p>
                <ol className="next-steps">
                  <li>The organizer approves your stall.</li>
                  <li>You set up your stall's phone from this page.</li>
                  <li>The organizer approves the phone, and you're ready to sell.</li>
                </ol>
              </>
            )}

            {standing.pairing === "NEEDS_PHONE" && (
              <>
                <p className="eyebrow">{standing.state === "LIVE" ? "Phone needed" : "Approved"}</p>
                <h1>Set up your stall's phone</h1>
                <p className="muted">
                  {standing.state === "LIVE"
                    ? `The phone you used now sells for another stall. Scan this code on it to sell as ${standing.stallName} again.`
                    : `${standing.stallName} is approved. Put this page on a laptop or a second screen, then scan the code with the stall's phone.`}
                </p>
                <PhoneSetupSteps />
                {setupImage ? (
                  <>
                    <div className="qr-frame">
                      {/* biome-ignore lint/performance/noImgElement: a generated data URL needs no optimization */}
                      <img src={setupImage} alt="Terminal setup code" width={260} height={260} />
                    </div>
                    <p className="muted waiting" aria-live="polite">
                      <span className="spinner" aria-hidden="true" /> Waiting for the phone to check
                      in…
                    </p>
                    <p className="fine-print">
                      Show this code only on your stall's phone. A new code replaces this one.
                    </p>
                  </>
                ) : (
                  <button
                    type="button"
                    className="block-button"
                    disabled={busy}
                    onClick={showSetupCode}
                  >
                    {busy ? "Getting your code…" : "Show setup code"}
                  </button>
                )}
              </>
            )}

            {standing.pairing === "CHECKED_IN" && (
              <>
                <p className="eyebrow">Phone checked in</p>
                <h1>Almost there</h1>
                <p className="muted waiting" aria-live="polite">
                  <span className="spinner" aria-hidden="true" /> Waiting for the organizer to
                  approve your phone. This page updates by itself.
                </p>
              </>
            )}

            {standing.state === "LIVE" && standing.pairing === null && (
              <>
                <p className="eyebrow">Live</p>
                <h1>You're ready to sell</h1>
                <p className="muted">
                  Customers can now choose <strong>{standing.stallName}</strong>. Keep the
                  OpenBalance Terminal app open on your stall's phone to take payments.
                </p>
              </>
            )}

            {standing.state === "DECLINED" && (
              <>
                <p className="eyebrow">Not approved</p>
                <h1>The organizer declined this stall</h1>
                <p className="muted">Contact the event organizer if you think this is a mistake.</p>
              </>
            )}

            {message && (
              <p role="alert" className="notice error">
                {message}
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
