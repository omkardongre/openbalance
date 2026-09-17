import type { Operations, Schemas } from "./generated/api.js";

export type { Operations, Paths, Schemas } from "./generated/api.js";

/** A typed failure returned by the API, preserving its machine-readable reason. */
export class OpenBalanceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly action: string | undefined;

  constructor(status: number, body: Partial<Schemas["Error"]>) {
    super(body.action ?? body.error ?? `Request failed with HTTP ${status}`);
    this.name = "OpenBalanceError";
    this.status = status;
    this.code = body.error ?? "unknown_error";
    this.retryable = body.retryable ?? status >= 500;
    this.action = body.action;
  }
}

export type OpenBalanceClientOptions = {
  baseUrl: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  sessionToken?: string;
};

type Operation = Operations[keyof Operations];
type BodyOf<O extends Operation> = O["requestBody"];

function assertBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("OpenBalance base URL is not allowed");
  return value.replace(/\/$/, "");
}

/**
 * Typed client over the OpenBalance API. It never holds payment authority: it issues requests and
 * surfaces the API's typed outcomes. Passkey signatures are produced by the caller's authenticator.
 */
export class OpenBalanceClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  #sessionToken: string | undefined;

  constructor(options: OpenBalanceClientOptions) {
    this.#baseUrl = assertBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#sessionToken = options.sessionToken;
  }

  setSession(token: string | undefined): void {
    this.#sessionToken = token;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; idempotencyKey?: string; authenticated?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    if (options.authenticated) {
      if (!this.#sessionToken) throw new Error("A session token is required for this request");
      headers.Authorization = `Bearer ${this.#sessionToken}`;
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new OpenBalanceError(response.status, body as Partial<Schemas["Error"]>);
    return body as T;
  }

  healthLive(): Promise<Schemas["Health"]> {
    return this.#request("GET", "/health/live");
  }

  createEnrollmentChallenge(): Promise<Record<string, unknown>> {
    return this.#request("POST", "/v1/accounts/enrollment-challenges", { body: {} });
  }

  registerPasskey(token: string, response: unknown): Promise<Record<string, unknown>> {
    return this.#request("POST", "/v1/accounts/enrollment/register", {
      body: { token, response },
    });
  }

  createAuthenticationChallenge(account: Schemas["Address"]): Promise<Record<string, unknown>> {
    return this.#request("POST", "/v1/accounts/authentication-challenges", { body: { account } });
  }

  async authenticate(challengeToken: string, response: unknown): Promise<Schemas["Session"]> {
    const session = await this.#request<Schemas["Session"]>(
      "POST",
      "/v1/accounts/authentications",
      { body: { challengeToken, response } },
    );
    this.#sessionToken = session.sessionToken;
    return session;
  }

  account(): Promise<Record<string, unknown>> {
    return this.#request("GET", "/v1/accounts/me", { authenticated: true });
  }

  activity(limit = 25): Promise<Schemas["Activity"]> {
    return this.#request("GET", `/v1/accounts/me/activity?limit=${limit}`, {
      authenticated: true,
    });
  }

  /** Grants clearly labelled test assets to the caller's own account. */
  fundTestBalance(
    amount: BodyOf<Operations["fundTestBalance"]>["amount"],
  ): Promise<Schemas["FaucetGrant"]> {
    return this.#request("POST", "/v1/funding/faucet", { body: { amount }, authenticated: true });
  }

  paymentIntent(id: string): Promise<Record<string, unknown>> {
    return this.#request("GET", `/v1/payment-intents/${id}`, { authenticated: true });
  }

  reserveChannel(id: string): Promise<Schemas["ReserveChannel"]> {
    return this.#request("GET", `/v1/reserve-channels/${id}`, { authenticated: true });
  }

  createCheckoutOrder(
    input: Schemas["CheckoutOrderRequest"],
    idempotencyKey: string,
  ): Promise<Schemas["CheckoutOrder"]> {
    return this.#request("POST", "/v1/checkout-orders", {
      body: input,
      idempotencyKey,
      authenticated: true,
    });
  }
}
