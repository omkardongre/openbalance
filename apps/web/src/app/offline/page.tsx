"use client";

import type { AttendeeChannelState } from "@openbalance/attendee";
import {
  decodeOfflineVoucher,
  decodePaymentRequestQr,
  type TerminalPaymentRequest,
} from "@openbalance/protocol";
import { BrowserQRCodeReader } from "@zxing/browser";
import Image from "next/image";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";
import { readSettlementStatuses, type SettlementStatus } from "../../lib/offline-settlement";
import {
  authorizeOfflineRequest,
  listOfflineAuthorizations,
  listOfflineChannels,
  type StoredAuthorization,
  storeTerminalReceipt,
} from "../../lib/offline-wallet";

/** How often to recheck finalized settlement while a payment is still open and the device is online. */
const SETTLEMENT_POLL_MS = 10_000;

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export default function OfflineWalletPage() {
  const video = useRef<HTMLVideoElement>(null);
  const [channels, setChannels] = useState<AttendeeChannelState[]>([]);
  const [authorizations, setAuthorizations] = useState<StoredAuthorization[]>([]);
  const [request, setRequest] = useState<TerminalPaymentRequest>();
  const [responseQr, setResponseQr] = useState<string>();
  const [responseImage, setResponseImage] = useState<string>();
  const [rawPayload, setRawPayload] = useState("");
  const [scanMode, setScanMode] = useState<"request" | "receipt">("request");
  const [busy, setBusy] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [status, setStatus] = useState("Load an active reserve, then scan the terminal request.");
  const [settlement, setSettlement] = useState<Map<string, SettlementStatus>>(new Map());

  const refresh = useCallback(async () => {
    const [nextChannels, nextAuthorizations] = await Promise.all([
      listOfflineChannels(),
      listOfflineAuthorizations(),
    ]);
    setChannels(nextChannels);
    setAuthorizations(nextAuthorizations);
  }, []);

  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : "Offline storage is unavailable."),
    );
  }, [refresh]);

  // Receipts move from "stored" to "settled" by themselves: while any payment is still open, recheck
  // the vault at the finalized block, and immediately when the device comes back online. A failed
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

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    let active = true;
    navigator.serviceWorker
      .register("/offline-sw.js", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        if (active) setOfflineReady(true);
      })
      .catch(() => {
        if (active) setOfflineReady(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const channel = useMemo(
    () => channels.find((candidate) => candidate.channelId === request?.channelId),
    [channels, request],
  );
  const voucher = request ? decodeOfflineVoucher(request.voucher) : undefined;

  async function consumePayload(payload: string, mode = scanMode) {
    if (mode === "request") {
      const decoded = decodePaymentRequestQr(payload.trim());
      const matching = channels.find((candidate) => candidate.channelId === decoded.channelId);
      if (!matching)
        throw new Error("No finalized reserve for this terminal exists on this device.");
      setRequest(decoded);
      setResponseQr(undefined);
      setResponseImage(undefined);
      setStatus("Verify the vendor, amount, and reserve before approving.");
      return;
    }
    await storeTerminalReceipt(payload.trim());
    await refresh();
    setStatus("Terminal receipt stored. Settlement is still pending until finalized onchain.");
  }

  async function scanQr(mode: "request" | "receipt") {
    if (!video.current) return;
    setBusy(true);
    setScanMode(mode);
    setStatus("Camera active. Hold the QR code steady inside the frame.");
    try {
      const result = await new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 100,
        delayBetweenScanSuccess: 500,
      }).decodeOnceFromVideoDevice(undefined, video.current);
      await consumePayload(result.getText(), mode);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The QR code could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!request || !channel) return;
    setBusy(true);
    try {
      const authorization = await authorizeOfflineRequest({ request });
      const image = await QRCode.toDataURL(authorization.responseQr, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 360,
      });
      setResponseQr(authorization.responseQr);
      setResponseImage(image);
      await refresh();
      setStatus(
        "Authorization stored. Let the terminal scan this response; payment remains pending settlement.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Offline approval was rejected.");
    } finally {
      setBusy(false);
    }
  }

  async function importPayload() {
    setBusy(true);
    try {
      await consumePayload(rawPayload);
      setRawPayload("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The payload could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="page-stack offline-stack">
        <section className="shell checkout-shell">
          <p className="eyebrow">Attendee offline wallet</p>
          <h1>Approve from your reserved balance.</h1>
          <p className="summary">
            Requests are checked against a finalized terminal-specific reserve. Every approval and
            returned terminal receipt stays on this device through a restart.
          </p>
          <p className={offlineReady ? "offline-ready" : "offline-not-ready"}>
            {offlineReady
              ? "Offline application shell installed on this device."
              : "Keep this page online until offline installation completes."}
          </p>
          <div className="offline-actions">
            <button
              type="button"
              disabled={busy || channels.length === 0}
              onClick={() => scanQr("request")}
            >
              Scan payment request
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => scanQr("receipt")}
            >
              Store terminal receipt
            </button>
          </div>
          <video
            ref={video}
            className="qr-camera"
            muted
            playsInline
            aria-label="QR scanner camera"
          />
          <details className="payload-import">
            <summary>Import an exact payload</summary>
            <label>
              {scanMode === "request" ? "Terminal request" : "Terminal receipt"}
              <textarea
                value={rawPayload}
                onChange={(event) => setRawPayload(event.target.value)}
              />
            </label>
            <button type="button" disabled={busy || !rawPayload.trim()} onClick={importPayload}>
              Verify payload
            </button>
          </details>
          <p role="status">{status}</p>
        </section>

        {request && channel && voucher && (
          <section className="shell checkout-shell offline-approval">
            <p className="eyebrow">Approval request</p>
            <div className="receipt-card">
              <span>{channel.display.vendorName}</span>
              <strong>
                {formatUnits(voucher.grossUnits, channel.display.assetDecimals)}{" "}
                {channel.display.assetSymbol}
              </strong>
              <small>Terminal {short(request.terminalId)}</small>
              <small>Sequence {request.sequence}</small>
              <small>
                Reserve after approval:{" "}
                {formatUnits(
                  channel.reserveUnits - voucher.cumulativeGrossUnits,
                  channel.display.assetDecimals,
                )}{" "}
                {channel.display.assetSymbol}
              </small>
              <small>
                Request expires {new Date(request.expiresAt * 1_000).toLocaleTimeString()}
              </small>
            </div>
            {!responseQr ? (
              <button type="button" disabled={busy} onClick={approve}>
                Approve exact offline payment
              </button>
            ) : (
              <div className="response-qr">
                {responseImage && (
                  <Image
                    src={responseImage}
                    alt="Signed attendee response QR"
                    width={360}
                    height={360}
                    unoptimized
                  />
                )}
                <code>{short(responseQr)}</code>
                <p>Accepted by your device, pending terminal receipt and onchain settlement.</p>
              </div>
            )}
          </section>
        )}

        <section className="shell checkout-shell">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Device records</p>
              <h2>Offline activity</h2>
            </div>
            <span>{channels.length} active reserves</span>
          </div>
          {authorizations.length === 0 ? (
            <p className="empty-state">No offline payments have been authorized on this device.</p>
          ) : (
            <ul className="activity-list">
              {authorizations.map((authorization) => (
                <li key={authorization.paymentId}>
                  <div>
                    <strong>{short(authorization.paymentId)}</strong>
                    <span>{authorization.grossUnits.toString()} base units</span>
                  </div>
                  <div className="proof-ref">
                    <span>
                      {authorization.supersededBy
                        ? "EXPIRED, REPLACED BY A NEWER REQUEST"
                        : settlement.get(authorization.paymentId) === "SETTLED"
                          ? "SETTLED ON MONAD"
                          : settlement.get(authorization.paymentId) === "RETURNED"
                            ? "NOT UPLOADED IN TIME · RETURNED TO YOU"
                            : settlement.get(authorization.paymentId) === "MISSED"
                              ? "NOT UPLOADED IN TIME · COMES BACK TO YOU"
                              : authorization.receipt
                                ? "TERMINAL RECEIPT STORED · SETTLING"
                                : "AWAITING TERMINAL RECEIPT"}
                    </span>
                    <small>{new Date(authorization.createdAt).toLocaleString()}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
