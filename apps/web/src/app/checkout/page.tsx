"use client";

import {
  decodeCheckoutCapability,
  decodeResolvedCheckoutRequest,
  type ReserveChannelConfig,
  type ResolvedCheckoutRequest,
} from "@openbalance/protocol";
import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import {
  type Address,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  type Hex,
  keccak256,
} from "viem";
import {
  financialIdempotencyKey,
  type PasskeyIdentity,
  paymentCommand,
  reserveCommand,
} from "../../lib/financial-client";
import {
  activateOfflineChannel,
  createOfflineChannelKey,
  stageOfflineChannel,
} from "../../lib/offline-wallet";

type Operation = {
  operationId: string;
  kind: string;
  aggregateId: Hex;
  state: "ACCEPTED" | "LEASED" | "SIGNED" | "SUBMITTED" | "FINALIZED" | "FAILED" | "QUARANTINED";
  transactionHash: Hex | null;
  finalizedBlockNumber: string | null;
  finalizedBlockHash: Hex | null;
  failureCode: string | null;
};
type PaymentProjection = {
  status: "FINALIZED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "CANCELLED";
  proof: { transactionHash: Hex; blockNumber: string; blockHash: Hex };
};
type ChannelProjection = {
  channelId: Hex;
  eventId: Hex;
  status: "ACTIVE" | "RECLAIMED";
  reserveUnits: string;
  spentUnits: string;
  returnedUnits: string;
  remainingUnits: string;
  submitUntil: string;
  proof: { transactionHash: Hex; blockNumber: string; blockHash: Hex };
};
type CheckoutLocator = ReturnType<typeof decodeCheckoutCapability>;
type PendingCheckout = {
  schemaVersion: 1;
  orderId: string;
  state: "CREATED" | "BOUND";
  grossUnits: string;
  expiresAt: string;
  display: {
    vendorName: string;
    orderReference: string;
    orderVersion: string;
    description: string;
    assetSymbol: string;
    assetDecimals: number;
  };
};

function short(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

async function serviceRequest<T>(
  base: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!base) throw new Error("Required service is not configured.");
  const response = await fetch(`${base}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      action?: string;
    } | null;
    throw new Error(
      body?.action ?? body?.error?.replaceAll("_", " ") ?? "The request was not accepted.",
    );
  }
  return response.json() as Promise<T>;
}

export default function CheckoutPage() {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const relayer = process.env.NEXT_PUBLIC_RELAYER_URL;
  const [checkout, setCheckout] = useState<ResolvedCheckoutRequest>();
  const [locator, setLocator] = useState<CheckoutLocator>();
  const [pending, setPending] = useState<PendingCheckout>();
  const [identity, setIdentity] = useState<PasskeyIdentity>();
  const [operation, setOperation] = useState<Operation>();
  const [payment, setPayment] = useState<PaymentProjection>();
  const [channelOperation, setChannelOperation] = useState<Operation>();
  const [channel, setChannel] = useState<ChannelProjection>();
  const [channelId, setChannelId] = useState<Hex>();
  const [channelKey, setChannelKey] = useState<{ keyId: string; signer: Address }>();
  const [reserveAmount, setReserveAmount] = useState("");
  const [reserveDraft, setReserveDraft] = useState<ReserveChannelConfig>();
  const [status, setStatus] = useState("Reading checkout…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const value = new URLSearchParams(window.location.hash.slice(1)).get("request");
        if (!value) throw new Error("This checkout link is incomplete.");
        const capability = decodeCheckoutCapability(decodeURIComponent(value));
        if (active) setLocator(capability);
        const resolved = await serviceRequest<unknown>(
          api,
          `/v1/checkout-orders/${encodeURIComponent(capability.orderId)}`,
          { headers: { Authorization: `Checkout ${capability.capability}` } },
        );
        const state = resolved as { state?: string };
        if (state.state === "CREATED" || state.state === "BOUND") {
          if (active) {
            setPending(resolved as PendingCheckout);
            setStatus(
              state.state === "CREATED"
                ? "Verify the order, then bind your passkey account."
                : "Account bound. The registered cashier terminal must sign the final intent.",
            );
          }
        } else {
          const verified = decodeResolvedCheckoutRequest(resolved);
          if (verified.intent.expiresAt <= Math.floor(Date.now() / 1_000))
            throw new Error("This checkout has expired. Ask the cashier for a new one.");
          if (active) {
            setCheckout(verified);
            setStatus("Verify the final signed order, then approve it with your passkey.");
          }
        }
      } catch (error) {
        if (active)
          setStatus(error instanceof Error ? error.message : "The checkout cannot be verified.");
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [api]);

  async function signIn() {
    if (!locator || (!pending && !checkout)) return;
    setBusy(true);
    try {
      // An approved checkout fixes the payer, so the challenge is bound to that account. Binding a
      // pending order is a discoverable sign-in: the chosen passkey names the account.
      const payer = checkout ? getAddress(checkout.intent.payerAccount) : undefined;
      const start = await serviceRequest<{
        challengeToken: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>(api, "/v1/accounts/authentication-challenges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payer ? { account: payer } : {}),
      });
      const assertion = await startAuthentication({ optionsJSON: start.options });
      const verified = await serviceRequest<{
        account: Address;
        sessionToken: string;
      }>(api, "/v1/accounts/authentications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken: start.challengeToken, response: assertion }),
      });
      const account = getAddress(verified.account);
      if (payer && account !== payer)
        throw new Error("The authenticated account does not match this checkout.");
      setIdentity({ account, credentialId: assertion.id, sessionToken: verified.sessionToken });
      if (pending) {
        await serviceRequest(
          api,
          `/v1/checkout-orders/${encodeURIComponent(locator.orderId)}/bindings`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${verified.sessionToken}`,
            },
            body: JSON.stringify({ checkoutCapability: locator.capability }),
          },
        );
        setPending((current) => (current ? { ...current, state: "BOUND" } : current));
        setStatus("Account bound. Ask the cashier to verify and sign the exact intent.");
      } else {
        setStatus("Account verified. Approval will ask for your passkey once more.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Account authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshCheckout() {
    if (!locator) return;
    setBusy(true);
    try {
      const resolved = await serviceRequest<unknown>(
        api,
        `/v1/checkout-orders/${encodeURIComponent(locator.orderId)}`,
        { headers: { Authorization: `Checkout ${locator.capability}` } },
      );
      const state = resolved as { state?: "CREATED" | "BOUND" };
      if (state.state) {
        setPending(resolved as PendingCheckout);
        setStatus(
          state.state === "CREATED"
            ? "The attendee account is not bound yet."
            : "Waiting for the registered cashier terminal signature.",
        );
      } else {
        const verified = decodeResolvedCheckoutRequest(resolved);
        if (identity && getAddress(verified.intent.payerAccount) !== identity.account)
          throw new Error("The signed intent belongs to another account.");
        setCheckout(verified);
        setPending(undefined);
        setStatus("Terminal signature verified. Approve the exact payment with your passkey.");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Checkout status is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCommand(kind: "PAYMENT" | "CANCELLATION") {
    if (!checkout || !identity) return;
    setBusy(true);
    try {
      const calldata = await paymentCommand({
        identity,
        intent: checkout.intent,
        encodedIntent: checkout.encodedIntent,
        terminalSignature: checkout.terminalSignature,
        cancel: kind === "CANCELLATION",
      });
      const result = await serviceRequest<Operation>(relayer, "/v1/accounts/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.sessionToken}`,
          "Idempotency-Key": financialIdempotencyKey(kind, checkout.intent.paymentId),
        },
        body: JSON.stringify({ kind, calldata }),
      });
      setOperation(result);
      setStatus("Authorized. Settlement is pending until the network finalizes it.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Payment authorization failed.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshOperation(target: "payment" | "channel") {
    const current = target === "payment" ? operation : channelOperation;
    if (!current || !identity) return;
    setBusy(true);
    try {
      // Reserve returns are public operations tracked per channel, not under this session.
      const next =
        current.kind === "RESERVE_RECLAIM"
          ? await serviceRequest<Operation>(
              relayer,
              `/v1/reserve-channels/${encodeURIComponent(current.aggregateId)}/reclaims`,
              {},
            )
          : await serviceRequest<Operation>(
              relayer,
              `/v1/financial-operations/${encodeURIComponent(current.operationId)}`,
              { headers: { Authorization: `Bearer ${identity.sessionToken}` } },
            );
      if (target === "payment") setOperation(next);
      else setChannelOperation(next);
      if (next.state === "FINALIZED") {
        try {
          if (target === "payment") {
            setPayment(
              await serviceRequest<PaymentProjection>(
                api,
                `/v1/payment-intents/${checkout?.intent.paymentId}`,
                { headers: { Authorization: `Bearer ${identity.sessionToken}` } },
              ),
            );
          } else if (channelId) {
            const finalizedChannel = await serviceRequest<ChannelProjection>(
              api,
              `/v1/reserve-channels/${channelId}`,
              {
                headers: { Authorization: `Bearer ${identity.sessionToken}` },
              },
            );
            setChannel(finalizedChannel);
            await activateOfflineChannel(channelId);
          }
          setStatus("Finalized state verified from the indexed chain record.");
        } catch {
          setStatus("Network finalized. The finalized indexer has not exposed the read-back yet.");
        }
      } else {
        setStatus(`Current operation state: ${next.state.toLowerCase()}.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Operation status is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function openReserve() {
    if (!checkout || !identity) return;
    setBusy(true);
    try {
      if (!channelKey) throw new Error("Create this device's offline key first.");
      const reserveUnits = reserveDraft?.reserveUnits ?? BigInt(reserveAmount);
      const maximum = BigInt(checkout.reservePolicy.maximumReserveUnits);
      const maxPerVoucher = BigInt(checkout.reservePolicy.maximumPerVoucherUnits);
      if (reserveUnits < 1n || reserveUnits > maximum)
        throw new Error("Reserve amount is outside the disclosed event limit.");
      const signer = getAddress(channelKey.signer);
      const derivedId = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "address" }],
          [checkout.intent.eventId, identity.account, checkout.intent.terminalInstanceId, signer],
        ),
      );
      const now = Math.floor(Date.now() / 1_000);
      const acceptUntil = now + checkout.reservePolicy.acceptanceDurationSeconds;
      const config: ReserveChannelConfig = reserveDraft ?? {
        channelId: derivedId,
        eventId: checkout.intent.eventId,
        asset: checkout.intent.asset,
        reserveUnits,
        vendorId: checkout.intent.vendorId,
        vendorDestinationVersion: checkout.intent.vendorDestinationVersion,
        terminalInstanceId: checkout.intent.terminalInstanceId,
        terminalKeyVersion: checkout.intent.terminalKeyVersion,
        attendeeChannelSigner: signer,
        configVersion: checkout.intent.configVersion,
        organizerFeeBps: checkout.intent.organizerFeeBps,
        platformFeeBps: checkout.intent.platformFeeBps,
        maxPerVoucher: reserveUnits < maxPerVoucher ? reserveUnits : maxPerVoucher,
        maxVoucherCount: checkout.reservePolicy.maximumVoucherCount,
        acceptFrom: now,
        acceptUntil,
        submitUntil: acceptUntil + checkout.reservePolicy.submissionDelaySeconds,
        genesisDigest: keccak256(
          encodeAbiParameters(
            [{ type: "string" }, { type: "bytes32" }],
            ["openbalance:reserve-genesis:v1", derivedId],
          ),
        ),
      };
      setReserveDraft(config);
      const deadline = BigInt(Math.min(config.acceptUntil, now + 300));
      const idempotencyKey = financialIdempotencyKey("RESERVE_OPEN", derivedId);
      await stageOfflineChannel({
        keyId: channelKey.keyId,
        signer,
        chainId: checkout.intent.chainId,
        vault: getAddress(checkout.reservePolicy.vault),
        terminalSigner: getAddress(checkout.reservePolicy.terminalSigner),
        config,
        operationId: idempotencyKey,
        display: {
          vendorName: checkout.display.vendorName,
          assetSymbol: checkout.display.assetSymbol,
          assetDecimals: checkout.display.assetDecimals,
        },
      });
      const calldata = await reserveCommand({
        identity,
        chainId: checkout.intent.chainId,
        vault: getAddress(checkout.reservePolicy.vault),
        config,
        maximumTotalReserve: maximum,
        deadline,
      });
      const result = await serviceRequest<Operation>(relayer, "/v1/accounts/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.sessionToken}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ kind: "RESERVE_OPEN", calldata }),
      });
      setChannelId(derivedId);
      setChannelOperation(result);
      setStatus("Reserve opening is pending network finality. No offline spend is final yet.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reserve creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createDeviceKey() {
    setBusy(true);
    try {
      setChannelKey(await createOfflineChannelKey());
      setStatus("Offline device key created and encrypted in this browser.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Offline key creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reclaim() {
    if (!checkout || !channelId) return;
    setBusy(true);
    try {
      const result = await serviceRequest<Operation>(
        relayer,
        `/v1/reserve-channels/${channelId}/reclaims`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: checkout.intent.eventId }),
        },
      );
      setChannelOperation(result);
      setStatus("Eligible reclaim accepted and pending network finality.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reserve reclaim was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="page-stack checkout-stack">
        <section className="shell checkout-shell">
          <p className="eyebrow">Attendee checkout</p>
          <h1>Approve exactly what you see.</h1>
          {checkout || pending ? (
            <>
              <div className="receipt-card">
                <span>{(checkout ?? pending)?.display.vendorName}</span>
                <strong>
                  {formatUnits(
                    checkout?.intent.grossUnits ?? BigInt(pending?.grossUnits ?? "0"),
                    (checkout ?? pending)?.display.assetDecimals ?? 0,
                  )}{" "}
                  {(checkout ?? pending)?.display.assetSymbol}
                </strong>
                <p>{(checkout ?? pending)?.display.description}</p>
                <small>Order {(checkout ?? pending)?.display.orderReference}</small>
                <small>
                  Expires{" "}
                  {new Date(
                    checkout ? checkout.intent.expiresAt * 1_000 : (pending?.expiresAt ?? 0),
                  ).toLocaleTimeString()}
                </small>
              </div>
              {!identity ? (
                <button type="button" disabled={busy} onClick={signIn}>
                  {pending ? "Verify and bind my passkey account" : "Verify my passkey account"}
                </button>
              ) : !checkout ? (
                <button type="button" disabled={busy} onClick={refreshCheckout}>
                  Check terminal approval
                </button>
              ) : !operation ? (
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => submitCommand("PAYMENT")}>
                    Approve exact payment
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => submitCommand("CANCELLATION")}
                  >
                    Cancel this signed intent
                  </button>
                </div>
              ) : (
                <OperationCard
                  operation={operation}
                  proof={payment?.proof}
                  onRefresh={() => refreshOperation("payment")}
                  busy={busy}
                />
              )}
            </>
          ) : (
            <p className="empty-state">No verified checkout is available.</p>
          )}
          <p role="status">{status}</p>
        </section>

        {checkout && identity && payment?.status === "FINALIZED" && (
          <section className="shell checkout-shell reserve-panel">
            <p className="eyebrow">Optional outage reserve</p>
            <h2>Prepare a bounded offline balance.</h2>
            <p>
              This reserve is locked to this vendor terminal and your separate offline device key.
              Unspent value becomes reclaimable only after the disclosed submission deadline.
            </p>
            {!channelOperation ? (
              <>
                {!channelKey ? (
                  <button type="button" disabled={busy} onClick={createDeviceKey}>
                    Protect an offline key on this device
                  </button>
                ) : (
                  <div className="device-key-summary">
                    <span>Device key ready</span>
                    <code>{short(channelKey.signer)}</code>
                    <small>
                      This scoped key cannot move funds outside the reserve and is not recoverable
                      if this browser's protected storage is cleared.
                    </small>
                  </div>
                )}
                <label>
                  Reserve amount in base units (maximum {checkout.reservePolicy.maximumReserveUnits}
                  )
                  <input
                    inputMode="numeric"
                    value={reserveAmount}
                    disabled={Boolean(reserveDraft)}
                    onChange={(event) => setReserveAmount(event.target.value)}
                  />
                </label>
                <button type="button" disabled={busy || !channelKey} onClick={openReserve}>
                  Create bounded reserve
                </button>
              </>
            ) : (
              <>
                <OperationCard
                  operation={channelOperation}
                  proof={channel?.proof}
                  onRefresh={() => refreshOperation("channel")}
                  busy={busy}
                />
                {channel && (
                  <div className="reserve-readback">
                    <span>{channel.status}</span>
                    <strong>{channel.remainingUnits} units remaining</strong>
                    <small>
                      Reclaim eligible{" "}
                      {new Date(Number(channel.submitUntil) * 1_000).toLocaleString()}
                    </small>
                    {channel.status === "ACTIVE" &&
                      Date.now() >= Number(channel.submitUntil) * 1_000 && (
                        <button type="button" disabled={busy} onClick={reclaim}>
                          Reclaim eligible balance
                        </button>
                      )}
                  </div>
                )}
                {channel?.status === "ACTIVE" && (
                  <a className="primary-action" href="/offline">
                    Open offline wallet
                  </a>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function OperationCard(input: {
  operation: Operation;
  proof: { transactionHash: Hex; blockNumber: string; blockHash: Hex } | undefined;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <section className="operation-card" aria-label="Settlement status">
      <div>
        <span>Settlement</span>
        <strong>{input.operation.state}</strong>
      </div>
      {input.operation.transactionHash && <code>{short(input.operation.transactionHash)}</code>}
      {input.proof && (
        <small>
          Finalized in block {input.proof.blockNumber} · {short(input.proof.blockHash)}
        </small>
      )}
      {input.operation.failureCode && <small>Failure: {input.operation.failureCode}</small>}
      <button type="button" disabled={input.busy} onClick={input.onRefresh}>
        Refresh verified status
      </button>
    </section>
  );
}
