"use client";

import { type AttendeeChannelState, canPayOpenRequest } from "@openbalance/attendee";
import {
  cursorKey,
  decodeOpenPaymentRequestQr,
  type OpenPaymentRequest,
} from "@openbalance/protocol";
import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { friendlyError } from "../../lib/account-display";
import { money, when } from "../../lib/format";
import { readSettlementStatuses, type SettlementStatus } from "../../lib/offline-settlement";
import {
  authorizeOpenRequest,
  listOfflineAuthorizations,
  listOfflineChannels,
  type StoredAuthorization,
  storeTerminalReceipt,
} from "../../lib/offline-wallet";
import { AttendeeNav } from "../attendee-nav";
import { useOfflineReady } from "../offline-shell";
import { QrScanner } from "./qr-scanner";

/** How often to recheck finalized settlement while a payment is still open and the device is online. */
const SETTLEMENT_POLL_MS = 10_000;
/** Payments listed per page on this device. */
const PAGE = 8;

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

/** Where one approved payment stands, in the attendee's words, with a tone for the status chip. */
function paymentStatus(
  authorization: StoredAuthorization,
  settlement: SettlementStatus | undefined,
): { label: string; tone: "ok" | "wait" | "muted" } {
  if (authorization.supersededBy) return { label: "Not charged", tone: "muted" };
  if (settlement === "SETTLED") return { label: "Paid", tone: "ok" };
  if (settlement === "RETURNED") return { label: "Refunded to you", tone: "muted" };
  if (settlement === "MISSED") return { label: "Not charged · coming back", tone: "muted" };
  if (authorization.receipt) return { label: "Confirming", tone: "wait" };
  return { label: "Waiting for stall", tone: "wait" };
}

export default function OfflineWalletPage() {
  const approval = useRef<HTMLElement>(null);
  const [scanning, setScanning] = useState<"request" | "receipt">();
  const [channels, setChannels] = useState<AttendeeChannelState[]>([]);
  const [authorizations, setAuthorizations] = useState<StoredAuthorization[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [request, setRequest] = useState<OpenPaymentRequest>();
  /** The reserve the customer pays from; defaults to the one that stops taking payments first. */
  const [chosen, setChosen] = useState<string>();
  /** The reserve an approval was signed from, kept so the answer stays on screen afterwards. */
  const [approvedFrom, setApprovedFrom] = useState<AttendeeChannelState>();
  const [responseImage, setResponseImage] = useState<string>();
  const [rawPayload, setRawPayload] = useState("");
  const [pasteMode, setPasteMode] = useState<"request" | "receipt">("request");
  const [busy, setBusy] = useState(false);
  // The worker itself is installed from every page by the root layout.
  const offlineReady = useOfflineReady();
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<Tone>("info");
  const [settlement, setSettlement] = useState<Map<string, SettlementStatus>>(new Map());
  const [shown, setShown] = useState(PAGE);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000));

  function report(message: string, nextTone: Tone = "info") {
    setStatus(message);
    setTone(nextTone);
  }

  const refresh = useCallback(async () => {
    const [nextChannels, nextAuthorizations] = await Promise.all([
      listOfflineChannels(),
      listOfflineAuthorizations(),
    ]);
    setChannels(nextChannels);
    setAuthorizations(nextAuthorizations);
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

  // Payments move from "confirming" to "paid" by themselves: while any is still open, recheck the
  // vault at the finalized block, and immediately when the device comes back online. A failed
  // read (offline, RPC down) keeps the last known status rather than guessing.
  const open = authorizations.some(
    (authorization) =>
      !authorization.supersededBy &&
      settlement.get(authorization.paymentId) !== "SETTLED" &&
      settlement.get(authorization.paymentId) !== "RETURNED",
  );
  useEffect(() => {
    if (!open) return;
    let active = true;
    const check = () => {
      if (!navigator.onLine) return;
      readSettlementStatuses(channels, authorizations)
        .then((next) => {
          if (active) setSettlement((previous) => new Map([...previous, ...next]));
        })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, SETTLEMENT_POLL_MS);
    window.addEventListener("online", check);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("online", check);
    };
  }, [open, channels, authorizations]);

  const byChannel = useMemo(
    () => new Map(channels.map((channel) => [channel.channelId.toLowerCase(), channel])),
    [channels],
  );
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
  const history = useMemo(
    () => [...authorizations].sort((left, right) => right.createdAt - left.createdAt),
    [authorizations],
  );

  async function consumePayload(payload: string, mode: "request" | "receipt") {
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

  // Bring the approval card into view as soon as a request is read, so the attendee sees what
  // they are about to approve without scrolling.
  useEffect(() => {
    if (request) approval.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [request]);

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

  async function importPayload() {
    setBusy(true);
    try {
      await consumePayload(rawPayload, pasteMode);
      setRawPayload("");
    } catch (error) {
      report(friendlyError(error, "That code could not be read."), "error");
    } finally {
      setBusy(false);
    }
  }

  const asset = assetOf(channel);
  const secondsLeft = request ? request.expiresAt - nowSeconds : 0;

  return (
    <main className="with-tabbar">
      <div className="page-stack offline-stack">
        <section className="shell narrow checkout-shell">
          <p className="eyebrow">Pay offline</p>
          <h1>Pay a stall without signal.</h1>
          <p className="summary">
            Scan the code on the stall&apos;s screen, check the amount, and approve. It is paid from
            the reserve you set aside for that stall.
          </p>

          {loaded && usable.length === 0 ? (
            <div className="empty-state">
              <p>
                You have no reserve you can spend right now. Set one aside for a stall while you are
                online.
              </p>
              <Link className="primary-action block-button" href="/account">
                Set aside a reserve
              </Link>
            </div>
          ) : (
            <ul className="reserve-chips" aria-label="Reserves you can spend now">
              {usable.map((item) => (
                <li key={item.channelId}>
                  <strong>{item.display.vendorName}</strong>
                  <span>
                    {money(item.reserveUnits - item.spentUnits, assetOf(item))} left · until{" "}
                    {new Date(item.acceptUntil * 1_000).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            className="block-button scan-button"
            disabled={busy || usable.length === 0}
            onClick={() => setScanning("request")}
          >
            Scan to pay
          </button>

          <p role="status" aria-live="polite" className={`notice ${tone === "info" ? "" : tone}`}>
            {status}
          </p>

          <p className={offlineReady ? "offline-ready" : "offline-not-ready"}>
            {offlineReady
              ? "Ready to work without signal on this phone."
              : "Keep this page open online once so it works without signal."}
          </p>

          <details className="payload-import">
            <summary>Camera not working? Paste the code instead</summary>
            <fieldset className="amount-row">
              <legend className="visually-hidden">Code type</legend>
              <button
                type="button"
                className="secondary-button"
                aria-pressed={pasteMode === "request"}
                onClick={() => setPasteMode("request")}
              >
                Payment code
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-pressed={pasteMode === "receipt"}
                onClick={() => setPasteMode("receipt")}
              >
                Receipt code
              </button>
            </fieldset>
            <label>
              {pasteMode === "request"
                ? "Payment code from the stall"
                : "Receipt code from the stall"}
              <textarea
                value={rawPayload}
                onChange={(event) => setRawPayload(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary-button block-button"
              disabled={busy || !rawPayload.trim()}
              onClick={importPayload}
            >
              Continue
            </button>
          </details>

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
        </section>

        {request && channel && gross !== undefined && asset && (
          <section ref={approval} className="shell narrow checkout-shell offline-approval">
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
                  onClick={() => setRequest(undefined)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <div className="response-qr">
                <p className="eyebrow">Approved</p>
                <h2>Show this to the stall</h2>
                <p className="muted">
                  {channel.display.vendorName} scans it to finish the {money(gross, asset)} payment.
                </p>
                <Image
                  src={responseImage}
                  alt={`Payment approval code for ${channel.display.vendorName}`}
                  width={360}
                  height={360}
                  unoptimized
                />
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
                  }}
                >
                  Done
                </button>
              </div>
            )}
          </section>
        )}

        <section className="shell narrow checkout-shell" aria-labelledby="history-heading">
          <div className="section-heading">
            <h2 id="history-heading">Payments on this phone</h2>
            {history.length > 0 && <p>{history.length}</p>}
          </div>
          {history.length === 0 ? (
            <p className="empty-state">No offline payments yet.</p>
          ) : (
            <ol className="activity-list ledger">
              {history.slice(0, shown).map((authorization) => {
                const owner = byChannel.get(authorization.channelId.toLowerCase());
                const state = paymentStatus(authorization, settlement.get(authorization.paymentId));
                return (
                  <li key={authorization.paymentId}>
                    <div>
                      <strong>{owner?.display.vendorName ?? "Stall"}</strong>
                      <span>{when(authorization.createdAt)}</span>
                    </div>
                    <div className="ledger-amount">
                      <strong>{money(authorization.grossUnits, assetOf(owner))}</strong>
                      <span className="chip" data-tone={state.tone}>
                        {state.label}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {history.length > shown && (
            <button
              type="button"
              className="secondary-button block-button"
              onClick={() => setShown((count) => count + PAGE)}
            >
              Show {Math.min(PAGE, history.length - shown)} more
            </button>
          )}
        </section>
      </div>
      <AttendeeNav />
    </main>
  );
}
