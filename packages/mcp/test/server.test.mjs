import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenBalanceClient } from "@openbalance/sdk";
import { handleRequest } from "../dist/server.js";

function clientWith(responses) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses.shift() ?? { status: 500, body: { error: "unexpected" } };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    client: new OpenBalanceClient({
      baseUrl: "http://127.0.0.1:3001",
      fetch: fetchImpl,
      sessionToken: "t",
    }),
    calls,
  };
}

test("initializes and lists tools", async () => {
  const { client } = clientWith([]);
  const initialized = await handleRequest(client, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initialized.result.capabilities.tools !== undefined, true);
  const listed = await handleRequest(client, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.ok(listed.result.tools.some((tool) => tool.name === "fund_test_balance"));
});

test("ignores notifications", async () => {
  const { client } = clientWith([]);
  const response = await handleRequest(client, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(response, null);
});

test("calls a tool and returns JSON content", async () => {
  const grant = {
    transactionHash: `0x${"a".repeat(64)}`,
    amount: "5000000",
    account: `0x${"b".repeat(40)}`,
  };
  const { client, calls } = clientWith([{ status: 200, body: grant }]);
  const response = await handleRequest(client, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "fund_test_balance", arguments: { amount: "5000000" } },
  });
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), grant);
  assert.match(calls[0].url, /\/v1\/funding\/faucet$/);
});

test("surfaces a typed API error as an MCP error result", async () => {
  const { client } = clientWith([
    { status: 429, body: { error: "faucet_exhausted", retryable: false } },
  ]);
  const response = await handleRequest(client, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "fund_test_balance", arguments: { amount: "1" } },
  });
  assert.equal(response.result.isError, true);
  assert.equal(JSON.parse(response.result.content[0].text).error, "faucet_exhausted");
});

test("reports an unknown method", async () => {
  const { client } = clientWith([]);
  const response = await handleRequest(client, { jsonrpc: "2.0", id: 5, method: "does/not/exist" });
  assert.equal(response.error.code, -32601);
});
