"use client";

import {
  decodePaymentIntent,
  encodeCheckoutCapability,
  type PaymentIntent,
  paymentIntentFields,
} from "@openbalance/protocol";
import { useState } from "react";
import { type Address, createWalletClient, custom, getAddress, type Hex, parseUnits } from "viem";

type CheckoutPolicy = {
  chainId: number;
  eventId: Hex;
  vendorId: Hex;
  vendorName: string;
  assetSymbol: string;
  assetDecimals: number;
  terminalSigner: Address;
};
type OperationsProfile = {
  role: string;
  eventId: Hex;
  vendorId: Hex | null;
  checkoutPolicy: CheckoutPolicy | null;
};
type CheckoutOrder = {
  schemaVersion: 1;
  orderId: string;
  state: "CREATED" | "BOUND" | "READY";
  capability: string;
  encodedIntent?: Hex;
  terminalSignature?: Hex | null;
  intentDigest?: Hex;
  expiresAt: string;
};

function provider() {
  const value = (
    window as unknown as {
      ethereum?: { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
    }
  ).ethereum;
  if (!value) throw new Error("Connect the registered cashier wallet to continue.");
  return value;
}

async function checkoutIdempotencyKey(input: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  const value = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `checkout-${value}`;
}

export default function CashierPage() {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const [credential, setCredential] = useState("");
  const [policy, setPolicy] = useState<CheckoutPolicy>();
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [orderVersion, setOrderVersion] = useState("1");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [order, setOrder] = useState<CheckoutOrder>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!api) throw new Error("Checkout API is not configured.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    const response = await fetch(`${api}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error?.replaceAll("_", " ") ?? "Checkout service is unavailable.");
    }
    return response.json() as Promise<T>;
  }

  async function authenticate() {
    setBusy(true);
    try {
      const profile = await request<OperationsProfile>("/v1/operations/me");
      if (profile.role !== "VENDOR" || !profile.checkoutPolicy)
        throw new Error("This credential is not authorized for a cashier terminal.");
      setPolicy(profile.checkoutPolicy);
      setStatus(`Ready for ${profile.checkoutPolicy.vendorName}.`);
    } catch (error) {
      setPolicy(undefined);
      setStatus(error instanceof Error ? error.message : "Cashier authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createCheckout() {
    if (!policy) return;
    setBusy(true);
    setCheckoutUrl("");
    try {
      const grossUnits = parseUnits(amount, policy.assetDecimals);
      if (grossUnits < 1n) throw new Error("Enter a positive payment amount.");
      const payload = {
        orderReference: reference.trim(),
        orderVersion,
        description: description.trim(),
        grossUnits: grossUnits.toString(),
      };
      const idempotencyKey = await checkoutIdempotencyKey({
        vendorId: policy.vendorId,
        ...payload,
      });
      const draft = await request<CheckoutOrder>("/v1/checkout-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(payload),
      });
      setOrder(draft);
      const encoded = encodeURIComponent(
        encodeCheckoutCapability({
          schemaVersion: 1,
          orderId: draft.orderId,
          capability: draft.capability,
        }),
      );
      setCheckoutUrl(`${window.location.origin}/checkout#request=${encoded}`);
      setStatus("Checkout link created. Ask the attendee to bind their passkey account.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Checkout creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approveBinding() {
    if (!policy || !order) return;
    setBusy(true);
    try {
      let current = await request<CheckoutOrder>(
        `/v1/checkout-orders/${encodeURIComponent(order.orderId)}/cashier`,
      );
      if (current.state === "CREATED") {
        setOrder(current);
        setStatus("Waiting for the attendee to bind their passkey account.");
        return;
      }
      if (current.state === "BOUND") {
        if (!current.encodedIntent) throw new Error("Bound checkout is incomplete.");
        const injected = provider();
        const accounts = await injected.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
          throw new Error("No cashier wallet is available.");
        const cashier = getAddress(accounts[0]);
        if (cashier !== getAddress(policy.terminalSigner))
          throw new Error("The connected wallet is not the registered terminal signer.");
        const chain = await injected.request({ method: "eth_chainId" });
        if (chain !== `0x${policy.chainId.toString(16)}`)
          throw new Error(`Switch the cashier wallet to chain ${policy.chainId}.`);
        const intent: PaymentIntent = decodePaymentIntent(current.encodedIntent);
        const wallet = createWalletClient({ account: cashier, transport: custom(injected) });
        const terminalSignature = await wallet.signTypedData({
          account: cashier,
          domain: {
            name: "OpenBalanceExactPay",
            version: "1",
            chainId: policy.chainId,
            verifyingContract: intent.router,
          },
          types: { PaymentIntent: paymentIntentFields },
          primaryType: "PaymentIntent",
          message: intent,
        });
        current = await request<CheckoutOrder>(
          `/v1/checkout-orders/${encodeURIComponent(current.orderId)}/terminal-signature`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ terminalSignature }),
          },
        );
      }
      setOrder(current);
      setStatus(
        current.state === "READY"
          ? "Attendee binding verified and signed by the registered terminal."
          : "Waiting for attendee binding.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Checkout creation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="page-stack checkout-stack">
        <section className="shell checkout-shell">
          <p className="eyebrow">Cashier</p>
          <h1>Create one exact checkout.</h1>
          <p className="summary">
            The registered terminal signs the vendor, order, account, amount, and expiry before the
            attendee sees the approval screen.
          </p>
          {!policy ? (
            <>
              <label>
                Vendor operations credential
                <input
                  type="password"
                  autoComplete="off"
                  value={credential}
                  disabled={busy}
                  onChange={(event) => setCredential(event.target.value)}
                />
              </label>
              <button type="button" disabled={busy || !credential} onClick={authenticate}>
                Authorize terminal
              </button>
            </>
          ) : (
            <div className="checkout-form">
              <p className="scope-chip">
                {policy.vendorName} · {policy.assetSymbol} · chain {policy.chainId}
              </p>
              <div className="field-grid">
                <label>
                  Order reference
                  <input value={reference} onChange={(event) => setReference(event.target.value)} />
                </label>
                <label>
                  Order version
                  <input
                    inputMode="numeric"
                    value={orderVersion}
                    onChange={(event) => setOrderVersion(event.target.value)}
                  />
                </label>
              </div>
              <label>
                What is being purchased
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                Amount ({policy.assetSymbol})
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <button type="button" disabled={busy} onClick={createCheckout}>
                {busy ? "Securing checkout…" : "Create checkout link"}
              </button>
            </div>
          )}
          <p role="status">{status}</p>
          {checkoutUrl && (
            <section className="checkout-link" aria-label="Attendee checkout link">
              <strong>Ready for attendee</strong>
              <input readOnly value={checkoutUrl} aria-label="Checkout URL" />
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(checkoutUrl);
                  setStatus("Checkout link copied.");
                }}
              >
                Copy secure link
              </button>
              <button
                type="button"
                disabled={busy || order?.state === "READY"}
                onClick={approveBinding}
              >
                {order?.state === "READY" ? "Terminal intent ready" : "Verify attendee and sign"}
              </button>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}
