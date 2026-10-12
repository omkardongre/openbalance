"use client";
import {
  decodeCheckoutCapability,
  decodeResolvedCheckoutRequest,
  type ResolvedCheckoutRequest,
} from "@openbalance/protocol";
import { startAuthentication } from "@simplewebauthn/browser";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, getAddress, type Hex } from "viem";
import { friendlyError } from "../../lib/account-display";
import {
  financialIdempotencyKey,
  type PasskeyIdentity,
  paymentCommand,
} from "../../lib/financial-client";
import { explorerTx, money } from "../../lib/format";
import { useSession } from "../session-provider";

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

/** The order link lives in the URL fragment; after an in-app navigation it may land a frame late. */
async function readLocator(): Promise<CheckoutLocator> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("request");
    if (value) return decodeCheckoutCapability(decodeURIComponent(value));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("This checkout link is incomplete.");
}

/**
 * One-scan online payment. The customer opens the stall's code, sees the amount, and approves it
 * with their passkey. If they are already signed in on this tab (they came from the Wallet), the
 * order is claimed without any prompt, so the only fingerprint is the payment itself.
 */
export default function CheckoutPage() {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const relayer = process.env.NEXT_PUBLIC_RELAYER_URL;
  const [checkout, setCheckout] = useState<ResolvedCheckoutRequest>();
  const [locator, setLocator] = useState<CheckoutLocator>();
  const [pending, setPending] = useState<PendingCheckout>();
  const [identity, setIdentity] = useState<PasskeyIdentity>();
  const [operation, setOperation] = useState<Operation>();
  const [payment, setPayment] = useState<PaymentProjection>();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const { session, signedIn } = useSession();
  // One poll at a time, so a slow answer is never overtaken by an older one.
  const polling = useRef(false);
  // The silent claim with an existing session runs once per page.
  const autoClaimed = useRef(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const capability = await readLocator();
        if (active) setLocator(capability);
        const resolved = await serviceRequest<unknown>(
          api,
          `/v1/checkout-orders/${encodeURIComponent(capability.orderId)}`,
          { headers: { Authorization: `Checkout ${capability.capability}` } },
        );
        const state = resolved as { state?: string };
        if (state.state === "CREATED" || state.state === "BOUND") {
          if (active) setPending(resolved as PendingCheckout);
        } else {
          const verified = decodeResolvedCheckoutRequest(resolved);
          if (verified.intent.expiresAt <= Math.floor(Date.now() / 1_000))
            throw new Error("This checkout has expired. Ask the cashier for a new one.");
          if (active) setCheckout(verified);
        }
      } catch (error) {
        if (active)
          setStatus(
            friendlyError(error, "This payment link is not valid. Ask the stall for a new one."),
          );
      } finally {
        if (active) setLoaded(true);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [api]);

  const bindOrder = useCallback(
    async (sessionToken: string) => {
      if (!locator) return;
      await serviceRequest(
        api,
        `/v1/checkout-orders/${encodeURIComponent(locator.orderId)}/bindings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
          body: JSON.stringify({ checkoutCapability: locator.capability }),
        },
      );
      setPending((current) => (current ? { ...current, state: "BOUND" } : current));
    },
    [api, locator],
  );

  const signIn = useCallback(async () => {
    if (!locator || (!pending && !checkout)) return;
    setBusy(true);
    try {
      // An approved checkout fixes the payer, so the challenge is bound to that account. Binding a
      // pending order is a discoverable sign-in: the chosen passkey names the account.
      const payer = checkout ? getAddress(checkout.intent.payerAccount) : undefined;
      // Already signed in on this tab (Wallet or an earlier payment): no passkey prompt to bind.
      if (session && (!payer || getAddress(session.account) === payer)) {
        const current = {
          account: getAddress(session.account),
          credentialId: session.credentialId,
          sessionToken: session.sessionToken,
        };
        setIdentity(current);
        if (pending?.state === "CREATED") await bindOrder(current.sessionToken);
        setStatus("");
        return;
      }
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
      signedIn({ account, credentialId: assertion.id, sessionToken: verified.sessionToken });
      if (pending?.state === "CREATED") await bindOrder(verified.sessionToken);
      setStatus("");
    } catch (error) {
      setStatus(friendlyError(error, "Sign-in failed. Try again."));
    } finally {
      setBusy(false);
    }
  }, [api, bindOrder, checkout, locator, pending, session, signedIn]);

  // Signed in already: claim the order straight away, no button and no passkey prompt.
  useEffect(() => {
    if (!session || identity || autoClaimed.current || !locator || (!pending && !checkout)) return;
    autoClaimed.current = true;
    void signIn();
  }, [session, identity, locator, pending, checkout, signIn]);

  /** Waits for the stall's phone to confirm the amount; it does so by itself within seconds. */
  const pollCheckout = useCallback(async () => {
    if (!locator || polling.current) return;
    polling.current = true;
    try {
      const resolved = await serviceRequest<unknown>(
        api,
        `/v1/checkout-orders/${encodeURIComponent(locator.orderId)}`,
        { headers: { Authorization: `Checkout ${locator.capability}` } },
      );
      if ((resolved as { state?: string }).state) return;
      const verified = decodeResolvedCheckoutRequest(resolved);
      if (identity && getAddress(verified.intent.payerAccount) !== identity.account)
        throw new Error("This payment belongs to a different account.");
      setCheckout(verified);
      setPending(undefined);
      setStatus("");
    } catch (error) {
      setStatus(
        friendlyError(error, "The stall cancelled this payment or it expired. Ask for a new code."),
      );
    } finally {
      polling.current = false;
    }
  }, [api, locator, identity]);

  useEffect(() => {
    if (pending?.state !== "BOUND" || checkout) return;
    const timer = window.setInterval(() => void pollCheckout(), 2_000);
    return () => window.clearInterval(timer);
  }, [pending?.state, checkout, pollCheckout]);

  async function pay() {
    if (!checkout || !identity) return;
    setBusy(true);
    try {
      const calldata = await paymentCommand({
        identity,
        intent: checkout.intent,
        encodedIntent: checkout.encodedIntent,
        terminalSignature: checkout.terminalSignature,
        cancel: false,
      });
      const result = await serviceRequest<Operation>(relayer, "/v1/accounts/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${identity.sessionToken}`,
          "Idempotency-Key": financialIdempotencyKey("PAYMENT", checkout.intent.paymentId),
        },
        body: JSON.stringify({ kind: "PAYMENT", calldata }),
      });
      setOperation(result);
      setStatus("");
    } catch (error) {
      setStatus(friendlyError(error, "The payment did not go through. You were not charged."));
    } finally {
      setBusy(false);
    }
  }

  async function refreshOperation() {
    if (!operation || !identity) return;
    setBusy(true);
    try {
      const next = await serviceRequest<Operation>(
        relayer,
        `/v1/financial-operations/${encodeURIComponent(operation.operationId)}`,
        { headers: { Authorization: `Bearer ${identity.sessionToken}` } },
      );
      setOperation(next);
      if (next.state === "FINALIZED") {
        await serviceRequest<PaymentProjection>(
          api,
          `/v1/payment-intents/${checkout?.intent.paymentId}`,
          { headers: { Authorization: `Bearer ${identity.sessionToken}` } },
        )
          .then(setPayment)
          .catch(() => undefined);
      }
      setStatus(next.failureCode ? "It did not go through. You were not charged." : "");
    } catch (error) {
      setStatus(friendlyError(error, "Could not check the status. Try again."));
    } finally {
      setBusy(false);
    }
  }

  // The payment confirms in a few seconds; follow it without a button.
  useEffect(() => {
    if (!operation || operation.state === "FINALIZED" || operation.failureCode) return;
    const timer = window.setInterval(() => {
      if (!busy) void refreshOperation();
    }, 2_000);
    return () => window.clearInterval(timer);
  });

  const display = (checkout ?? pending)?.display;
  const grossUnits = checkout?.intent.grossUnits ?? BigInt(pending?.grossUnits ?? "0");
  const amount = display
    ? money(grossUnits, { symbol: display.assetSymbol, decimals: display.assetDecimals })
    : "";
  const finished = operation?.state === "FINALIZED" || Boolean(operation?.failureCode);

  return (
    <main>
      <div className="page-stack checkout-stack">
        <section className="shell checkout-shell">
          <p className="eyebrow">Pay</p>
          <h1>{operation?.state === "FINALIZED" ? "Paid." : "Check the amount, then pay."}</h1>
          {display ? (
            <>
              <div className="receipt-card">
                <span>{display.vendorName}</span>
                <strong>{amount}</strong>
                <small>Paid from your wallet balance</small>
              </div>
              {!identity ? (
                <button type="button" disabled={busy || Boolean(session)} onClick={signIn}>
                  {session || busy ? "One moment…" : "Sign in with passkey"}
                </button>
              ) : !checkout ? (
                // The one place this waiting state is shown; the status line stays for errors.
                !status && (
                  <p className="notice" aria-live="polite">
                    Getting the stall&apos;s confirmation…
                  </p>
                )
              ) : !operation ? (
                <button type="button" disabled={busy} onClick={pay}>
                  {busy ? "Paying…" : `Pay ${amount}`}
                </button>
              ) : (
                <OperationCard
                  operation={operation}
                  proof={payment?.proof}
                  onRefresh={refreshOperation}
                  busy={busy}
                />
              )}
            </>
          ) : (
            loaded &&
            !status && (
              <p className="empty-state">
                This payment link is not valid or has expired. Ask the stall for a new one.
              </p>
            )
          )}
          {status && <p role="status">{status}</p>}
          {(finished || (loaded && !display)) && (
            <Link className="secondary-action block-button" href="/account">
              Back to wallet
            </Link>
          )}
        </section>
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
      {input.operation.state !== "FINALIZED" && !input.operation.failureCode && (
        <button
          type="button"
          className="text-button"
          disabled={input.busy}
          onClick={input.onRefresh}
        >
          Check status
        </button>
      )}
    </section>
  );
}
