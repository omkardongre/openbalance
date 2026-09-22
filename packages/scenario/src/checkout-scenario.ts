import { readFile, writeFile } from "node:fs/promises";
import {
  accountAbi,
  accountCommandDigest,
  decodePaymentIntent,
  type PaymentIntent,
  paymentIntentDigest,
} from "@openbalance/protocol";
import {
  type Address,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChainFor } from "./account-scenario.js";
import { VirtualAuthenticator, type VirtualAuthenticatorState } from "./authenticator.js";

/**
 * Drives the online exact-payment path: a cashier issues an order, the attendee binds their own
 * account to it, the registered terminal approves the resulting intent, and the attendee authorizes
 * `pay` with a passkey assertion the account contract verifies on chain. The relayer sponsors the
 * gas and broadcasts, so the attendee never holds gas and never signs a transaction.
 *
 * This is the counterpart to the reserve/voucher path in `treasury-scenario.ts`. Both settle through
 * the same router, but only this one proves `ExactPayRouter.pay` and the account's `PAY`
 * authorization, which are what an online tap actually uses.
 *
 * Every authority here is held by whoever owns it in production: the operations token is the
 * vendor's, the terminal key is the terminal's, and the payment authorization is the attendee's.
 * Nothing is signed on another party's behalf.
 */
export type CheckoutScenarioOptions = {
  apiUrl: string;
  relayerUrl: string;
  rpcUrl: string;
  statePath: string;
  /** Vendor-scoped operations bearer token; authorizes order issuance and terminal approval. */
  operationsToken: string;
  /** Key registered on chain as this terminal's signer. */
  terminalPrivateKey: Hex;
  rpId?: string;
  origin?: string;
  grossUnits?: bigint;
  orderReference?: string;
  description?: string;
};

export type CheckoutScenarioResult = {
  kind: "checkout-online-payment";
  account: Address;
  orderId: string;
  paymentId: Hex;
  intentDigest: Hex;
  grossUnits: string;
  operationId: string;
  state: string;
  transactionHash: Hex;
  finalizedBlockNumber: string;
  payerBalanceBefore: string;
  payerBalanceAfter: string;
};

type JourneyState = {
  account: Address;
  enrollmentId: string;
  authenticator: VirtualAuthenticatorState;
};

type PublicOrder = {
  orderId: string;
  state: string;
  grossUnits: string;
  paymentId?: Hex;
  encodedIntent?: Hex;
  terminalSignature?: Hex | null;
  intentDigest?: Hex;
};

type FinancialOperation = {
  operationId: string;
  state: string;
  transactionHash?: Hex;
  finalizedBlockNumber?: string;
  failureCode?: string | null;
};

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export async function runCheckoutScenario(
  options: CheckoutScenarioOptions,
): Promise<CheckoutScenarioResult> {
  const origin = options.origin ?? "http://localhost:3000";
  const grossUnits = options.grossUnits ?? 1_500_000n;
  const orderReference = options.orderReference ?? `ONLINE-${Date.now()}`;
  const description = options.description ?? "Flat white";

  async function call<T>(base: string, path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        // Both services reject a mutating request whose Origin is not the configured one, so the
        // harness presents the same origin a browser would rather than bypassing the check.
        origin,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(body)}`);
    return body as T;
  }

  const state = JSON.parse(await readFile(options.statePath, "utf8")) as JourneyState;
  const authenticator = VirtualAuthenticator.restore(state.authenticator);
  const account = getAddress(state.account);
  // Asserting consumes a signature counter the service records immediately. Every assertion below is
  // therefore persisted the moment it is accepted rather than at the end of the run: a failure after
  // an accepted assertion would otherwise strand the state file one counter behind the service, and
  // every later restore would be refused as a replay.
  const persist = () =>
    writeFile(
      options.statePath,
      JSON.stringify({ ...state, authenticator: authenticator.toJSON() }),
      "utf8",
    );

  // The cashier leg. Vendor authority only: this cannot move money, it can only offer a price.
  const order = await call<PublicOrder & { capability: string }>(
    options.apiUrl,
    "/v1/checkout-orders",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.operationsToken}`,
        "idempotency-key": `checkout:${orderReference}`,
      },
      body: JSON.stringify({
        orderReference,
        orderVersion: 1,
        description,
        grossUnits: grossUnits.toString(),
      }),
    },
  );

  // The attendee signs in with the passkey. This session authorizes binding and the later command,
  // but it is not itself authority to pay: that needs a fresh assertion over the payment terms.
  const challenge = await call<{ challengeToken: string; options: { challenge: string } }>(
    options.apiUrl,
    "/v1/accounts/authentication-challenges",
    { method: "POST", body: JSON.stringify({ account }) },
  );
  const session = await call<{ sessionToken: string; account: Address }>(
    options.apiUrl,
    "/v1/accounts/authentications",
    {
      method: "POST",
      body: JSON.stringify({
        challengeToken: challenge.challengeToken,
        response: authenticator.authenticationBase64Url(challenge.options.challenge),
      }),
    },
  );
  if (getAddress(session.account) !== account)
    throw new Error("Session was issued for another account");
  await persist();

  // Binding is what turns a price into an intent naming this payer. The server builds the intent and
  // verifies it against finalized registry state; the harness never supplies intent terms.
  const bound = await call<PublicOrder>(
    options.apiUrl,
    `/v1/checkout-orders/${order.orderId}/bindings`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ checkoutCapability: order.capability }),
    },
  );
  if (bound.state !== "BOUND" || !bound.encodedIntent || !bound.paymentId)
    throw new Error(`Binding did not produce an intent (state: ${bound.state})`);

  const intent: PaymentIntent = decodePaymentIntent(bound.encodedIntent);
  if (getAddress(intent.payerAccount) !== account)
    throw new Error("Bound intent names another payer");
  if (intent.grossUnits !== grossUnits) throw new Error("Bound intent changed the amount");
  const intentDigest = paymentIntentDigest(intent);

  // The terminal approves the intent digest with the key the registry binds to this terminal
  // version. Signed raw: the router recovers from the digest itself, not a prefixed message.
  const terminal = privateKeyToAccount(options.terminalPrivateKey);
  const terminalSignature = await terminal.sign({ hash: intentDigest });
  const ready = await call<PublicOrder>(
    options.apiUrl,
    `/v1/checkout-orders/${order.orderId}/terminal-signature`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${options.operationsToken}` },
      body: JSON.stringify({ terminalSignature }),
    },
  );
  if (ready.state !== "READY" || !ready.terminalSignature)
    throw new Error(`Terminal approval did not make the order payable (state: ${ready.state})`);

  // The attendee reads the payable order back through the capability, which is the only thing they
  // hold: they are not an operator and cannot read the vendor's orders.
  const resolved = await call<PublicOrder>(options.apiUrl, `/v1/checkout-orders/${order.orderId}`, {
    method: "GET",
    headers: { authorization: `Checkout ${order.capability}` },
  });
  if (!resolved.encodedIntent || !resolved.terminalSignature)
    throw new Error("Resolved order is not payable");

  const chain = await resolveChainFor(options.rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const [chainId, epoch, nonce, contractOrigin] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "epoch" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "nonce" }),
    publicClient.readContract({ address: account, abi: accountAbi, functionName: "origin" }),
  ]);
  // The account pins the origin its assertions must carry. A mismatch would be rejected on chain
  // after spending gas, so it is checked here where the failure is legible.
  if (contractOrigin !== origin)
    throw new Error(`Account expects origin ${contractOrigin}, harness is using ${origin}`);

  const payerBalanceBefore = await publicClient.readContract({
    address: intent.asset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
  if (payerBalanceBefore < grossUnits)
    throw new Error(
      `Payer holds ${payerBalanceBefore} units, needs ${grossUnits}; fund the account first`,
    );

  // The authorization the account contract verifies: a P-256 assertion over the EIP-712 command
  // digest, binding this payment's router and intent to this account's current epoch and nonce.
  const deadline = BigInt(intent.expiresAt);
  const terms = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [intent.router, intentDigest]),
  );
  const auth = authenticator.assert(
    accountCommandDigest({ chainId, account, action: "PAY", terms, epoch, nonce, deadline }),
  );
  await persist();
  const calldata = encodeFunctionData({
    abi: accountAbi,
    functionName: "pay",
    args: [
      intent.router,
      resolved.encodedIntent,
      resolved.terminalSignature,
      deadline,
      false,
      auth,
    ],
  });

  const accepted = await call<FinancialOperation>(options.relayerUrl, "/v1/accounts/commands", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.sessionToken}`,
      "idempotency-key": `financial:PAYMENT:${bound.paymentId.toLowerCase()}`,
    },
    body: JSON.stringify({ kind: "PAYMENT", calldata }),
  });

  // Acceptance is a queued operation, not a settled payment. Only FINALIZED means the chain has it,
  // so the counter is persisted and the balance re-read after that and not before.
  const finalized = await (async () => {
    const limit = Date.now() + 180_000;
    for (;;) {
      const current = await call<FinancialOperation>(
        options.relayerUrl,
        `/v1/financial-operations/${accepted.operationId}`,
        { method: "GET", headers: { authorization: `Bearer ${session.sessionToken}` } },
      );
      if (current.state === "FINALIZED") return current;
      if (current.state === "FAILED" || current.failureCode)
        throw new Error(`Payment failed: ${current.failureCode ?? current.state}`);
      if (Date.now() >= limit)
        throw new Error(`Payment was not finalized (last state: ${current.state})`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  })();
  if (!finalized.transactionHash || !finalized.finalizedBlockNumber)
    throw new Error("Finalized payment reported no transaction or block");

  const payerBalanceAfter = await publicClient.readContract({
    address: intent.asset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
  if (payerBalanceBefore - payerBalanceAfter !== grossUnits)
    throw new Error(
      `Payer balance moved by ${payerBalanceBefore - payerBalanceAfter}, expected ${grossUnits}`,
    );

  return {
    kind: "checkout-online-payment",
    account,
    orderId: order.orderId,
    paymentId: bound.paymentId,
    intentDigest,
    grossUnits: grossUnits.toString(),
    operationId: accepted.operationId,
    state: finalized.state,
    transactionHash: finalized.transactionHash,
    finalizedBlockNumber: finalized.finalizedBlockNumber,
    payerBalanceBefore: payerBalanceBefore.toString(),
    payerBalanceAfter: payerBalanceAfter.toString(),
  };
}
