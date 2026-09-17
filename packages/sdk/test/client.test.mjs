import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenBalanceClient, OpenBalanceError } from "../dist/index.js";

function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = init?.headers ?? {};
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses.shift() ?? { status: 500, body: { error: "unexpected" } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

const grant = {
  transactionHash: `0x${"a".repeat(64)}`,
  amount: "5000000",
  account: `0x${"b".repeat(40)}`,
};

test("funds a test balance with the session token and returns the grant", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: grant }]);
  const client = new OpenBalanceClient({
    baseUrl: "http://127.0.0.1:3001",
    fetch: fetchImpl,
    sessionToken: "session-token",
  });
  const result = await client.fundTestBalance("5000000");
  assert.deepEqual(result, grant);
  assert.equal(calls[0].url, "http://127.0.0.1:3001/v1/funding/faucet");
  assert.equal(calls[0].headers.Authorization, "Bearer session-token");
  assert.deepEqual(JSON.parse(calls[0].body), { amount: "5000000" });
});

test("requires a session for authenticated calls", async () => {
  const { fetchImpl } = stubFetch([]);
  const client = new OpenBalanceClient({ baseUrl: "http://127.0.0.1:3001", fetch: fetchImpl });
  await assert.rejects(() => client.activity(), /session token is required/);
});

test("maps a typed API failure and preserves its retry classification", async () => {
  const { fetchImpl } = stubFetch([
    { status: 429, body: { error: "faucet_exhausted", retryable: false } },
  ]);
  const client = new OpenBalanceClient({
    baseUrl: "http://127.0.0.1:3001",
    fetch: fetchImpl,
    sessionToken: "t",
  });
  const error = await client.fundTestBalance("1").catch((thrown) => thrown);
  assert.ok(error instanceof OpenBalanceError);
  assert.equal(error.code, "faucet_exhausted");
  assert.equal(error.status, 429);
  assert.equal(error.retryable, false);
});

test("sends an idempotency key for checkout orders and rejects a plaintext remote URL", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 201, body: { created: true } }]);
  const client = new OpenBalanceClient({
    baseUrl: "http://127.0.0.1:3001/",
    fetch: fetchImpl,
    sessionToken: "t",
  });
  await client.createCheckoutOrder(
    {
      orderReference: "ORDER1",
      orderVersion: "1",
      description: "Two coffees",
      grossUnits: "12000000",
    },
    "checkout-1",
  );
  assert.equal(calls[0].headers["Idempotency-Key"], "checkout-1");
  assert.throws(() => new OpenBalanceClient({ baseUrl: "http://api.example.com" }), /not allowed/);
});
