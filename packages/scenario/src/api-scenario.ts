import { type Address, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./account-scenario.js";
import { VirtualAuthenticator } from "./authenticator.js";

export type ApiScenarioOptions = {
  apiUrl: string;
  rpcUrl: string;
  sponsorPrivateKey: Hex;
  rpId?: string;
  origin?: string;
  fundAmount?: bigint;
};

export type ApiScenarioResult = {
  kind: "api-journey";
  enrollmentId: string;
  account: Address;
  deploymentBlock: string;
  fundedUnits: string;
  activityCount: number;
};

let requestOrigin: string | undefined;

async function call<T>(url: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(requestOrigin ? { origin: requestOrigin } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body as T;
}

/**
 * Drives the real API through the passkey journey: enroll a credential, deploy the account with a
 * sponsored transaction, sign in, fund the test balance, and read finalized activity. Every step is
 * verified by the running service, not by this harness.
 */
export async function runApiScenario(options: ApiScenarioOptions): Promise<ApiScenarioResult> {
  const rpId = options.rpId ?? "localhost";
  const origin = options.origin ?? "http://localhost:3000";
  const fundAmount = options.fundAmount ?? 5_000_000n;
  requestOrigin = origin;
  const authenticator = VirtualAuthenticator.create({ rpId, origin });

  const begin = await call<{ token: string; options: { challenge: string } }>(
    options.apiUrl,
    "/v1/accounts/enrollment-challenges",
    { method: "POST", body: "{}" },
  );
  const registered = await call<{ status: string; options: { challenge: string } }>(
    options.apiUrl,
    "/v1/accounts/enrollments/register",
    {
      method: "POST",
      body: JSON.stringify({
        token: begin.token,
        response: authenticator.registrationBase64Url(begin.options.challenge),
      }),
    },
  );
  if (registered.status !== "prove")
    throw new Error("Enrollment did not advance to the proof step");
  const verified = await call<{ status: string; enrollmentId: string; publicKey: { x: string } }>(
    options.apiUrl,
    "/v1/accounts/enrollments/prove",
    {
      method: "POST",
      body: JSON.stringify({
        token: begin.token,
        response: authenticator.authenticationBase64Url(registered.options.challenge),
      }),
    },
  );
  if (verified.status !== "verified") throw new Error("Enrollment proof was not verified");

  const prepared = await call<{
    account: Address;
    transaction: { to: Address; data: Hex; value: Hex; chainId: Hex };
  }>(options.apiUrl, "/v1/accounts/deployments/prepare", {
    method: "POST",
    body: JSON.stringify({ token: begin.token }),
  });

  const chain = chainFor(options.rpcUrl);
  const sponsor = privateKeyToAccount(options.sponsorPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: sponsor });
  const hash = await wallet.sendTransaction({
    to: prepared.transaction.to,
    data: prepared.transaction.data,
    value: BigInt(prepared.transaction.value),
    account: sponsor,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const confirmed = await call<{ status: string; block: string }>(
    options.apiUrl,
    "/v1/accounts/deployments/confirm",
    { method: "POST", body: JSON.stringify({ token: begin.token }) },
  );
  if (confirmed.status !== "confirmed") throw new Error("Account deployment was not confirmed");

  const challenge = await call<{ challengeToken: string; options: { challenge: string } }>(
    options.apiUrl,
    "/v1/accounts/authentication-challenges",
    { method: "POST", body: JSON.stringify({ account: prepared.account }) },
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
  if (session.account.toLowerCase() !== prepared.account.toLowerCase())
    throw new Error("Session was issued for another account");

  const grant = await call<{ amount: string; transactionHash: Hex }>(
    options.apiUrl,
    "/v1/funding/faucet",
    {
      method: "POST",
      headers: { authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ amount: fundAmount.toString() }),
    },
  );
  if (grant.amount !== fundAmount.toString()) throw new Error("Faucet granted another amount");

  const activity = await call<{ items: unknown[] }>(
    options.apiUrl,
    "/v1/accounts/me/activity?limit=25",
    { method: "GET", headers: { authorization: `Bearer ${session.sessionToken}` } },
  );

  return {
    kind: "api-journey",
    enrollmentId: verified.enrollmentId,
    account: prepared.account,
    deploymentBlock: confirmed.block,
    fundedUnits: grant.amount,
    activityCount: activity.items.length,
  };
}
