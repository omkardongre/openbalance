import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErpNextClient } from "../src/erpnext.js";
import { PartnerUnavailable } from "../src/http.js";
import { PretixClient } from "../src/pretix.js";

const token = "a".repeat(32);
const apiKey = "k".repeat(20);
const apiSecret = "s".repeat(24);
const method = "openbalance.api.record_finalized_payment";
const orderCode = "ORDER1";
const paymentId = `0x${"1".repeat(64)}` as const;
const transactionHash = `0x${"2".repeat(64)}` as const;
const blockHash = `0x${"3".repeat(64)}` as const;

type Recorded = {
  method: string;
  path: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
};
const requests: Recorded[] = [];
const written = new Map<string, Record<string, unknown>>();
let tamperReadBack = false;
let baseUrl = "";

function json(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.length,
  });
  response.end(payload);
}

function receipt(transitionId: string, amountUnits: string) {
  return {
    transition_id: transitionId,
    company: "OpenBalance Demo",
    sales_invoice: "ACC-SINV-0001",
    payment_entry: "ACC-PAY-0001",
    payment_id: paymentId,
    amount_units: amountUnits,
    asset_code: "USDC",
    chain_id: "10143",
    transaction_hash: transactionHash,
    docstatus: 1,
  };
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

let server: Server;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
    });
    if (request.method === "GET" && url.pathname.startsWith("/api/v1/organizers/")) {
      const code = url.pathname.split("/").at(-2);
      if (code !== orderCode) return json(response, 404, { detail: "not found" });
      return json(response, 200, {
        code: orderCode,
        status: "p",
        testmode: true,
        datetime: "2026-09-13T10:00:00Z",
        last_modified: "2026-09-13T10:01:00Z",
        email: "private@example.test",
        positions: [
          { id: 7, canceled: false, secret: "never-return" },
          { id: 8, canceled: true },
        ],
      });
    }
    if (url.pathname === `/api/method/${method}` && request.method === "POST") {
      const body = await readBody(request);
      const transitionId = String(body.transition_id);
      const stored = receipt(transitionId, String(body.amount_units));
      written.set(transitionId, stored);
      return json(response, 200, { message: stored });
    }
    if (url.pathname === `/api/method/${method}` && request.method === "GET") {
      const transitionId = url.searchParams.get("transition_id") ?? "";
      const stored = written.get(transitionId);
      if (!stored) return json(response, 404, { detail: "not found" });
      const result = tamperReadBack ? { ...stored, amount_units: "1" } : stored;
      return json(response, 200, { message: result });
    }
    json(response, 404, { detail: "unknown route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("partner adapters against a local mock", () => {
  it("reads scoped pretix admission over HTTP with minimal output", async () => {
    const client = new PretixClient({ baseUrl, organizer: "market", event: "autumn", token });
    const admission = await client.readAdmission(orderCode);
    expect(admission).toEqual({
      orderCode,
      state: "PAID",
      testMode: true,
      activePositionIds: [7],
      lastModified: "2026-09-13T10:01:00Z",
    });
    expect(JSON.stringify(admission)).not.toContain("private@example.test");
    const recorded = requests.at(-1);
    expect(recorded?.path).toBe(`/api/v1/organizers/market/events/autumn/orders/${orderCode}/`);
    expect(recorded?.authorization).toBe(`Token ${token}`);
  });

  it("rejects a foreign pretix order and an unknown order", async () => {
    const client = new PretixClient({ baseUrl, organizer: "market", event: "autumn", token });
    await expect(client.readAdmission("ORDER2")).rejects.toBeInstanceOf(PartnerUnavailable);
  });

  it("writes and reads back a finalized payment through ERPNext", async () => {
    const client = new ErpNextClient({ baseUrl, apiKey, apiSecret, method });
    const result = await client.recordFinalizedPayment({
      transitionId: "stream:transition:1",
      company: "OpenBalance Demo",
      orderReference: "ORDER1",
      paymentId,
      payer: `0x${"4".repeat(40)}`,
      amountUnits: 12_000_000n,
      assetCode: "USDC",
      chainId: 10_143n,
      transactionHash,
      blockNumber: 42n,
      blockHash,
    });
    expect(result).toMatchObject({ readBack: true, salesInvoice: "ACC-SINV-0001" });
    const post = requests.find((entry) => entry.method === "POST");
    expect(post?.idempotencyKey).toBe("stream:transition:1");
    expect(post?.authorization).toBe(`token ${apiKey}:${apiSecret}`);
  });

  it("rejects a read-back that disagrees with the write", async () => {
    tamperReadBack = true;
    try {
      const client = new ErpNextClient({ baseUrl, apiKey, apiSecret, method });
      await expect(
        client.recordFinalizedPayment({
          transitionId: "stream:transition:2",
          company: "OpenBalance Demo",
          orderReference: "ORDER2",
          paymentId,
          payer: `0x${"4".repeat(40)}`,
          amountUnits: 5_000_000n,
          assetCode: "USDC",
          chainId: 10_143n,
          transactionHash,
          blockNumber: 43n,
          blockHash,
        }),
      ).rejects.toThrow(/read-back mismatch/);
    } finally {
      tamperReadBack = false;
    }
  });
});
