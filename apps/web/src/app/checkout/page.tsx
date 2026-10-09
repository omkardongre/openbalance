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
  parseUnits,
} from "viem";
import { friendlyError } from "../../lib/account-display";
import {
  financialIdempotencyKey,
  type PasskeyIdentity,
  paymentCommand,
  reserveCommand,
} from "../../lib/financial-client";
import { explorerTx } from "../../lib/format";
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

async function serviceRequest<T>(
  base: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!base) throw new Error("The service is unavailable right now. Try again later.");
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
                : "Signed in. Waiting for the cashier to confirm.",
            );
          }
        } else {
          const verified = decodeResolvedCheckoutRequest(resolved);
          if (verified.intent.expiresAt <= Math.floor(Date.now() / 1_000))
            throw new Error("This checkout has expired. Ask the cashier for a new one.");
          if (active) {
            setCheckout(verified);
            setStatus("Check the stall and amount, then pay with your passkey.");
          }
        }
      } catch (error) {
        if (active)
          setStatus(
            friendlyError(error, "This payment link is not valid. Ask the stall for a new one."),
          );
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
        throw new Error(
          "This payment belongs to a different account. Sign in with the passkey you used before.",
        );
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
        setStatus("Signed in. Ask the cashier to confirm the payment on their screen.");
      } else {
        setStatus("Signed in. Paying will ask for your passkey once more.");
      }
    } catch (error) {
      setStatus(friendlyError(error, "Sign-in failed. Try again."));
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
            : "Waiting for the cashier to confirm.",
        );
      } else {
        const verified = decodeResolvedCheckoutRequest(resolved);
        if (identity && getAddress(verified.intent.payerAccount) !== identity.account)
          throw new Error("This payment belongs to a different account.");
        setCheckout(verified);
        setPending(undefined);
        setStatus("The cashier confirmed. Pay with your passkey.");
      }
    } catch (error) {
      setStatus(friendlyError(error, "Could not check the payment. Try again."));
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
      setStatus("Payment sent. Confirming, this takes a few seconds.");
    } catch (error) {
      setStatus(friendlyError(error, "The payment did not go through. You were not charged."));
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
          setStatus("Paid. Your payment is confirmed.");
        } catch {
          setStatus("Paid. Your receipt will appear in a moment.");
        }
      } else {
        setStatus("Still confirming. This takes a few seconds.");
      }
    } catch (error) {
      setStatus(friendlyError(error, "Could not check the status. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function openReserve() {
    if (!checkout || !identity) return;
    setBusy(true);
    try {
      if (!channelKey) throw new Error("Set up offline payments on this phone first.");
      const reserveUnits =
        reserveDraft?.reserveUnits ??
        parseUnits(reserveAmount.trim() || "0", checkout.display.assetDecimals);
      const maximum = BigInt(checkout.reservePolicy.maximumReserveUnits);
      const maxPerVoucher = BigInt(checkout.reservePolicy.maximumPerVoucherUnits);
      if (reserveUnits < 1n || reserveUnits > maximum)
        throw new Error("Choose an amount within the limit shown.");
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
      setStatus("Setting the money aside. This takes a few seconds.");
    } catch (error) {
      setStatus(
        friendlyError(error, "The money could not be set aside. Your balance is unchanged."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function createDeviceKey() {
    setBusy(true);
    try {
      setChannelKey(await createOfflineChannelKey());
      setStatus("Offline payments are set up on this phone.");
    } catch (error) {
      setStatus(friendlyError(error, "Offline payments could not be set up on this phone."));
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
      setStatus("Returning the unspent money to you. This takes a few seconds.");
    } catch (error) {
      setStatus(friendlyError(error, "The money could not be returned yet. Try again later."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="page-stack checkout-stack">
        <section className="shell checkout-shell">
          <p className="eyebrow">Checkout</p>
          <h1>Check the amount, then pay.</h1>
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
                  Sign in with passkey to pay
                </button>
              ) : !checkout ? (
                <button type="button" disabled={busy} onClick={refreshCheckout}>
                  Check if the cashier confirmed
                </button>
              ) : !operation ? (
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => submitCommand("PAYMENT")}>
                    Pay now
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => submitCommand("CANCELLATION")}
                  >
                    Cancel payment
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
            <p className="empty-state">
              This payment link is not valid or has expired. Ask the stall for a new one.
            </p>
          )}
          <p role="status">{status}</p>
        </section>

        {checkout && identity && payment?.status === "FINALIZED" && (
          <section className="shell checkout-shell reserve-panel">
            <p className="eyebrow">Optional</p>
            <h2>Keep paying if the network goes down.</h2>
            <p>
              Set a small amount aside for this stall. You can pay it from this phone with no
              signal. Whatever you do not spend comes back to your account after the event.
            </p>
            {!channelOperation ? (
              <>
                {!channelKey ? (
                  <button type="button" disabled={busy} onClick={createDeviceKey}>
                    Set up offline payments on this phone
                  </button>
                ) : (
                  <div className="device-key-summary">
                    <span>Offline payments ready on this phone</span>
                    <small>
                      It can only spend the money you set aside here. Clearing this browser's data
                      removes it.
                    </small>
                  </div>
                )}
                <label>
                  Amount to set aside, in USDC (up to{" "}
                  {formatUnits(
                    BigInt(checkout.reservePolicy.maximumReserveUnits),
                    checkout.display.assetDecimals,
                  )}
                  )
                  <input
                    inputMode="decimal"
                    value={reserveAmount}
                    disabled={Boolean(reserveDraft)}
                    onChange={(event) => setReserveAmount(event.target.value)}
                  />
                </label>
                <button type="button" disabled={busy || !channelKey} onClick={openReserve}>
                  Set money aside
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
                    <span>{channel.status === "ACTIVE" ? "Ready" : "Returned"}</span>
                    <strong>
                      {formatUnits(BigInt(channel.remainingUnits), checkout.display.assetDecimals)}{" "}
                      {checkout.display.assetSymbol} left
                    </strong>
                    <small>
                      Unspent money can come back from{" "}
                      {new Date(Number(channel.submitUntil) * 1_000).toLocaleString()}
                    </small>
                    {channel.status === "ACTIVE" &&
                      Date.now() >= Number(channel.submitUntil) * 1_000 && (
                        <button type="button" disabled={busy} onClick={reclaim}>
                          Return unspent money
                        </button>
                      )}
                  </div>
                )}
                {channel?.status === "ACTIVE" && (
                  <a className="primary-action" href="/offline">
                    Pay offline
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

/** Operation states in words a payer understands. */
function statusLabel(state: string) {
  if (state === "FINALIZED") return "Done";
  if (state === "FAILED" || state === "REJECTED") return "Did not go through";
  return "Confirming";
}
function OperationCard(input: {
  operation: Operation;
  proof: { transactionHash: Hex; blockNumber: string; blockHash: Hex } | undefined;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <section className="operation-card" aria-label="Payment status">
      <div>
        <span>Status</span>
        <strong>{statusLabel(input.operation.state)}</strong>
      </div>
      {input.operation.transactionHash && (
        <a
          className="text-button"
          href={explorerTx(input.operation.transactionHash)}
          target="_blank"
          rel="noreferrer"
        >
          View receipt
        </a>
      )}
      {input.operation.failureCode && <small>It did not go through. You were not charged.</small>}
      <button type="button" disabled={input.busy} onClick={input.onRefresh}>
        Check status
      </button>
    </section>
  );
}
