import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { type Address, createPublicClient, createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChainFor } from "./account-scenario.js";
import { VirtualAuthenticator, type VirtualAuthenticatorState } from "./authenticator.js";

export type ApiScenarioOptions = {
  apiUrl: string;
  rpcUrl: string;
  sponsorPrivateKey: Hex;
  rpId?: string;
  origin?: string;
  fundAmount?: bigint;
  /**
   * Credential identifier for the virtual authenticator. Defaults to a value derived from the
   * relying-party identifier, which is stable by design so a local harness run is reproducible.
   * A persistent remote environment keeps every credential it has ever registered, so enrolling
   * again there requires a distinct identifier rather than a repeat of the registered one.
   */
  credentialId?: Hex;
  /**
   * Relayer base URL. When set, the account is deployed through the relayer's bounded sponsorship
   * route, which is the path the product actually uses: the attendee holds no gas and never signs a
   * deployment. Without it the harness signs and broadcasts the prepared transaction with its own
   * key, which proves the deployment but not the sponsorship, because the sponsor's policy, quota
   * and signing key are never involved.
   */
  relayerUrl?: string;
};

export type ApiEnrollmentResult = {
  kind: "api-enrollment";
  enrollmentId: string;
  account: Address;
  deploymentBlock: string;
};

export type ApiFundingResult = {
  kind: "api-funding";
  account: Address;
  fundedUnits: string;
  activityCount: number;
};

export type ApiScenarioResult = {
  kind: "api-journey";
  enrollmentId: string;
  account: Address;
  deploymentBlock: string;
  fundedUnits: string;
  activityCount: number;
};

type JourneyState = {
  account: Address;
  enrollmentId: string;
  authenticator: VirtualAuthenticatorState;
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
 * Enrolls a passkey and deploys the account through the running API, persisting the authenticator
 * and account so the journey can continue in another process. Every step is verified by the
 * service, not by this harness.
 */
export async function runApiEnrollment(
  options: ApiScenarioOptions & { statePath: string },
): Promise<ApiEnrollmentResult> {
  const rpId = options.rpId ?? "localhost";
  const origin = options.origin ?? "http://localhost:3000";
  requestOrigin = origin;
  const authenticator = VirtualAuthenticator.create({
    rpId,
    origin,
    ...(options.credentialId ? { credentialId: options.credentialId } : {}),
  });

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
  const verified = await call<{ status: string; enrollmentId: string }>(
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

  let account: Address;
  if (options.relayerUrl) {
    // The relayer both signs and broadcasts under its own sponsorship policy, so the account address
    // comes back from it rather than from a prepared transaction this process would have sent.
    const sponsored = await call<{ account: Address; status: string }>(
      options.relayerUrl,
      "/v1/accounts/deployments/sponsor",
      {
        method: "POST",
        headers: { "idempotency-key": `account-deployment:${randomUUID()}` },
        body: JSON.stringify({ token: begin.token }),
      },
    );
    account = sponsored.account;
  } else {
    const prepared = await call<{
      account: Address;
      transaction: { to: Address; data: Hex; value: Hex };
    }>(options.apiUrl, "/v1/accounts/deployments/prepare", {
      method: "POST",
      body: JSON.stringify({ token: begin.token }),
    });

    const chain = await resolveChainFor(options.rpcUrl);
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
    account = prepared.account;
  }

  // Confirmation is a read of finalized chain state, so it is asked for separately and in both cases:
  // a sponsored deployment that has been broadcast is not yet a deployment the service will vouch for.
  // A mined deployment is not yet a finalized one, so an unconfirmed answer is retried: the service
  // is reporting the finality it can currently see, not a rejection.
  const confirmed = await (async () => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const answer = await call<{ status: string; block: string }>(
        options.apiUrl,
        "/v1/accounts/deployments/confirm",
        { method: "POST", body: JSON.stringify({ token: begin.token }) },
      );
      if (answer.status === "confirmed") return answer;
      if (Date.now() >= deadline)
        throw new Error(`Account deployment was not confirmed (last status: ${answer.status})`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  })();

  const state: JourneyState = {
    account,
    enrollmentId: verified.enrollmentId,
    authenticator: authenticator.toJSON(),
  };
  await writeFile(options.statePath, JSON.stringify(state), "utf8");
  return {
    kind: "api-enrollment",
    enrollmentId: verified.enrollmentId,
    account,
    deploymentBlock: confirmed.block,
  };
}

/**
 * Continues the journey in a fresh process: restores the enrolled credential, signs in, funds the
 * test balance and reads finalized activity. Running this after a restart proves the service state
 * survived.
 */
export async function runApiFunding(
  options: ApiScenarioOptions & { statePath: string },
): Promise<ApiFundingResult> {
  const origin = options.origin ?? "http://localhost:3000";
  requestOrigin = origin;
  const state = JSON.parse(await readFile(options.statePath, "utf8")) as JourneyState;
  const authenticator = VirtualAuthenticator.restore(state.authenticator);
  const persist = () =>
    writeFile(
      options.statePath,
      JSON.stringify({ ...state, authenticator: authenticator.toJSON() }),
      "utf8",
    );

  const challenge = await call<{ challengeToken: string; options: { challenge: string } }>(
    options.apiUrl,
    "/v1/accounts/authentication-challenges",
    { method: "POST", body: JSON.stringify({ account: state.account }) },
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
  if (session.account.toLowerCase() !== state.account.toLowerCase())
    throw new Error("Session was issued for another account");

  // Persist the advanced counter as soon as the assertion is accepted, not at the end of the run.
  // The service has already recorded it by this point, so a later failure would otherwise leave the
  // state file describing a counter the service has consumed, and every subsequent restore would be
  // refused as a replay with no way back.
  await persist();

  const fundAmount = options.fundAmount ?? 5_000_000n;
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
    kind: "api-funding",
    account: state.account,
    fundedUnits: grant.amount,
    activityCount: activity.items.length,
  };
}

/** Runs enrollment and funding in one process. */
export async function runApiScenario(options: ApiScenarioOptions): Promise<ApiScenarioResult> {
  const statePath = `${process.env.TMPDIR ?? "/tmp"}/openbalance-api-journey-${Date.now()}.json`;
  const enrolled = await runApiEnrollment({ ...options, statePath });
  const funded = await runApiFunding({ ...options, statePath });
  return {
    kind: "api-journey",
    enrollmentId: enrolled.enrollmentId,
    account: funded.account,
    deploymentBlock: enrolled.deploymentBlock,
    fundedUnits: funded.fundedUnits,
    activityCount: funded.activityCount,
  };
}
