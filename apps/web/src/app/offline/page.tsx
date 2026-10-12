"use client";

import { type AttendeeChannelState, canPayOpenRequest } from "@openbalance/attendee";
import {
  cursorKey,
  decodeOpenPaymentRequestQr,
  type OpenPaymentRequest,
} from "@openbalance/protocol";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { friendlyError } from "../../lib/account-display";
import { money } from "../../lib/format";
import {
  authorizeOpenRequest,
  listOfflineChannels,
  storeTerminalReceipt,
} from "../../lib/offline-wallet";
import { useOfflineReady, useOnline } from "../offline-shell";
import { QrScanner } from "./qr-scanner";

type Tone = "info" | "success" | "error";

function assetOf(channel: AttendeeChannelState | undefined) {
  return channel
    ? { symbol: channel.display.assetSymbol, decimals: channel.display.assetDecimals }
    : undefined;
}

/** A reserve can pay right now: inside its window with money and sales left. */
function spendable(channel: AttendeeChannelState, nowSeconds: number) {
  return (
    channel.status === "ACTIVE" &&
    nowSeconds >= channel.acceptFrom &&
    nowSeconds < channel.acceptUntil &&
    channel.reserveUnits > channel.spentUnits &&
    channel.approvedVoucherCount < channel.maxVoucherCount
  );
}

export default function OfflineWalletPage() {
  const router = useRouter();
  const [scanning, setScanning] = useState<"request" | "receipt">();
  const [channels, setChannels] = useState<AttendeeChannelState[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [request, setRequest] = useState<OpenPaymentRequest>();
  /** The reserve the customer pays from; defaults to the one that stops taking payments first. */
  const [chosen, setChosen] = useState<string>();
  /** The reserve an approval was signed from, kept so the answer stays on screen afterwards. */
  const [approvedFrom, setApprovedFrom] = useState<AttendeeChannelState>();
  const [responseImage, setResponseImage] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The worker itself is installed from every page by the root layout.
  const offlineReady = useOfflineReady();
  const online = useOnline();
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<Tone>("info");
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));

  function report(message: string, nextTone: Tone = "info") {
    setStatus(message);
    setTone(nextTone);
  }

  const refresh = useCallback(async () => {
    setChannels(await listOfflineChannels());
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh().catch(() => {
      setLoaded(true);
      setStatus("This browser's storage is unavailable, so offline payments cannot work here.");
      setTone("error");
    });
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1_000)), 1_000);
    return () => clearInterval(timer);
  }, []);

  // The Wallet's "Scan to pay" button opens this page straight into the scanner.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("scan") === "1") {
      setScanning("request");
      window.history.replaceState(null, "", "/offline");
    }
  }, []);
  const usable = channels.filter((channel) => spendable(channel, nowSeconds));
  // Reserves that can pay this charge, soonest-closing first so money about to stop being
  // spendable is used before money that stays spendable longer.
  const payable = request
    ? channels
        .filter((item) => canPayOpenRequest(item, request, nowSeconds))
        .sort((left, right) => left.acceptUntil - right.acceptUntil)
    : [];
  const channel =
    approvedFrom ?? payable.find((item) => item.channelId.toLowerCase() === chosen) ?? payable[0];
  const gross = request ? BigInt(request.grossUnits) : undefined;

  async function consumePayload(payload: string, mode: "request" | "receipt") {
    const text = payload.trim();
    // With signal the stall shows a link to pay from the wallet balance; open it on this site only.
    if (mode === "request" && text.startsWith(`${window.location.origin}/checkout#`)) {
      if (!navigator.onLine)
        throw new Error("This stall is taking payments online. Connect to the internet to pay.");
      // In-app navigation keeps this tab's sign-in, so checkout asks for no second passkey.
      const target = new URL(text);
      router.push(`${target.pathname}${target.hash}`);
      return;
    }
    if (mode === "request") {
      const decoded = decodeOpenPaymentRequestQr(payload.trim());
      const now = Math.floor(Date.now() / 1_000);
      const forStall = channels.filter(
        (item) =>
          item.terminalId.toLowerCase() === decoded.terminalId.toLowerCase() &&
          decoded.cursors.some((entry) => entry.startsWith(`${cursorKey(item.channelId)}:`)),
      );
      if (forStall.length === 0)
        throw new Error(
          "This stall has no reserve from you on this phone. Set one aside in your wallet first.",
        );
      if (!forStall.some((item) => canPayOpenRequest(item, decoded, now)))
        throw new Error(
          "Your reserve for this stall cannot cover this amount right now. Pay another way or ask for a smaller amount.",
        );
      setChosen(undefined);
      setApprovedFrom(undefined);
      setRequest(decoded);
      setResponseImage(undefined);
      report("");
      return;
    }
    await storeTerminalReceipt(payload.trim());
    await refresh();
    setRequest(undefined);
    setResponseImage(undefined);
    report("Receipt saved. The payment finishes confirming in the background.", "success");
  }

  async function scanned(text: string) {
    const mode = scanning ?? "request";
    setScanning(undefined);
    setBusy(true);
    try {
      await consumePayload(text, mode);
    } catch (error) {
      report(
        friendlyError(error, "") ||
          "That code is not an OpenBalance payment. Scan the code on the stall's screen.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Each step replaces the one before it, so start every step at the top of the screen.
  const step = !request ? "scan" : responseImage ? "show" : "approve";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step change is the trigger itself.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  async function approve() {
    if (!request || !channel) return;
    setBusy(true);
    try {
      const authorization = await authorizeOpenRequest({ request, channelId: channel.channelId });
      setApprovedFrom(channel);
      const image = await QRCode.toDataURL(authorization.responseQr, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 720,
      });
      setResponseImage(image);
      await refresh();
      report("");
    } catch (error) {
      report(friendlyError(error, "The payment was not approved."), "error");
    } finally {
      setBusy(false);
    }
  }

  const asset = assetOf(channel);
  const secondsLeft = request ? request.expiresAt - nowSeconds : 0;

  return (
    <main>
      <div className="page-stack offline-stack">
        {/* One step on screen at a time: scan, then approve, then show the answer to the stall. */}
        {step === "scan" && (
          <section className="shell narrow checkout-shell">
            {/* A full page load offline, so the saved copy of the Wallet answers with no network. */}
            {online ? (
              <Link className="back-link" href="/account">
                ← Back to wallet
              </Link>
            ) : (
              <a className="back-link" href="/account">
                ← Back to wallet
              </a>
            )}
            <h1>Pay a stall</h1>
            <p className="summary">Scan the code on the stall&apos;s screen.</p>

            <button
              type="button"
              className="block-button scan-button"
              // With signal any stall can be paid from the wallet; without it, only from money set aside.
              disabled={busy || (!online && usable.length === 0)}
              onClick={() => setScanning("request")}
            >
              Scan to pay
            </button>

            {/* With no signal, the only money that can pay is what was set aside; say how much. */}
            {loaded && !online && (
              <p className="muted offline-hint">
                {usable.length === 0 ? (
                  <>
                    No signal and nothing set aside. Next time you are online,{" "}
                    <a href="/account">set a little aside</a> for the stalls you use.
                  </>
                ) : (
                  `You have ${usable
                    .map(
                      (item) =>
                        `${money(item.reserveUnits - item.spentUnits, assetOf(item))} set aside for ${item.display.vendorName}`,
                    )
                    .join(", ")}.`
                )}
              </p>
            )}

            {status && (
              <p
                role="status"
                aria-live="polite"
                className={`notice ${tone === "info" ? "" : tone}`}
              >
                {status}
              </p>
            )}

            {!offlineReady && (
              <p className="offline-not-ready">
                Keep this page open online once so it works without signal.
              </p>
            )}
          </section>
        )}

        {scanning && (
          <QrScanner
            title={scanning === "request" ? "Scan to pay" : "Scan the stall's receipt"}
            hint={
              scanning === "request"
                ? "Point at the code on the stall's screen. Hold about 20 cm away until it reads."
                : "Point at the receipt code on the stall's screen."
            }
            onResult={(text) => void scanned(text)}
            onCancel={() => setScanning(undefined)}
          />
        )}

        {request && channel && gross !== undefined && asset && (
          <section className="shell narrow checkout-shell offline-approval">
            {!responseImage ? (
              <>
                <p className="eyebrow">Check and approve</p>
                <div className="receipt-card">
                  <span>{channel.display.vendorName}</span>
                  <strong>{money(gross, asset)}</strong>
                  <small>
                    Left in this reserve after:{" "}
                    {money(channel.reserveUnits - channel.spentUnits - gross, asset)}
                  </small>
                  <small className={secondsLeft <= 30 ? "countdown urgent" : "countdown"}>
                    {secondsLeft > 0
                      ? `Request expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
                      : "This request expired. Ask the stall to charge again."}
                  </small>
                </div>
                {payable.length > 1 && (
                  <label className="reserve-choice">
                    Pay from
                    <select
                      value={channel.channelId.toLowerCase()}
                      disabled={busy}
                      onChange={(event) => setChosen(event.target.value)}
                    >
                      {payable.map((item) => (
                        <option key={item.channelId} value={item.channelId.toLowerCase()}>
                          {money(item.reserveUnits - item.spentUnits, assetOf(item))} left · until{" "}
                          {new Date(item.acceptUntil * 1_000).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {status && (
                  <p
                    role="status"
                    aria-live="polite"
                    className={`notice ${tone === "info" ? "" : tone}`}
                  >
                    {status}
                  </p>
                )}
                <button
                  type="button"
                  className="block-button"
                  disabled={busy || secondsLeft <= 0}
                  onClick={approve}
                >
                  {busy ? "Approving…" : `Approve ${money(gross, asset)}`}
                </button>
                <button
                  type="button"
                  className="secondary-button block-button"
                  disabled={busy}
                  onClick={() => {
                    setRequest(undefined);
                    report("");
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <div className="response-qr">
                <h2>Show this to the stall</h2>
                <Image
                  src={responseImage}
                  alt={`Payment approval code for ${channel.display.vendorName}`}
                  width={360}
                  height={360}
                  unoptimized
                />
                <p className="muted">
                  {channel.display.vendorName} scans it to finish the {money(gross, asset)} payment.
                </p>
                {status && (
                  <p
                    role="status"
                    aria-live="polite"
                    className={`notice ${tone === "info" ? "" : tone}`}
                  >
                    {status}
                  </p>
                )}
                <button
                  type="button"
                  className="secondary-button block-button"
                  onClick={() => setScanning("receipt")}
                >
                  Scan the stall&apos;s receipt
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setRequest(undefined);
                    setResponseImage(undefined);
                    report("");
                  }}
                >
                  Done
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
