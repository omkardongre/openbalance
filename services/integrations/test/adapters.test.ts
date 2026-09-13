import { expect, it } from "vitest";
import { ErpNextClient } from "../src/erpnext.js";
import type { JsonRequest, JsonTransport } from "../src/http.js";
import { PretixClient } from "../src/pretix.js";

class SequenceTransport implements JsonTransport {
  readonly calls: JsonRequest[] = [];
  constructor(private readonly results: unknown[]) {}
  async request(input: JsonRequest) {
    this.calls.push(input);
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected request");
    return result;
  }
}

it("returns only scoped pretix admission state", async () => {
  const transport = new SequenceTransport([
    {
      code: "ORDER1",
      status: "p",
      testmode: true,
      datetime: "2026-09-13T10:00:00Z",
      last_modified: "2026-09-13T10:01:00Z",
      email: "private@example.test",
      positions: [
        { id: 7, canceled: false, secret: "never-return" },
        { id: 8, canceled: true },
      ],
    },
  ]);
  const client = new PretixClient({
    baseUrl: "https://tickets.example/",
    organizer: "market",
    event: "autumn",
    token: "a".repeat(32),
    transport,
  });
  await expect(client.readAdmission("ORDER1")).resolves.toEqual({
    orderCode: "ORDER1",
    state: "PAID",
    testMode: true,
    activePositionIds: [7],
    lastModified: "2026-09-13T10:01:00Z",
  });
  expect(transport.calls[0]?.url.pathname).toBe(
    "/api/v1/organizers/market/events/autumn/orders/ORDER1/",
  );
});

it("requires an exact ERPNext write read-back", async () => {
  const message = {
    transition_id: "stream:transition:1",
    company: "OpenBalance Demo",
    sales_invoice: "ACC-SINV-0001",
    payment_entry: "ACC-PAY-0001",
    payment_id: `0x${"1".repeat(64)}`,
    amount_units: "12000000",
    asset_code: "USDC",
    chain_id: "10143",
    transaction_hash: `0x${"2".repeat(64)}`,
    docstatus: 1,
  };
  const transport = new SequenceTransport([{ message }, { message }]);
  const client = new ErpNextClient({
    baseUrl: "https://erp.example/",
    apiKey: "api-key-1",
    apiSecret: "s".repeat(32),
    transport,
  });
  await expect(
    client.recordFinalizedPayment({
      transitionId: message.transition_id,
      company: message.company,
      orderReference: "ORDER1-v1",
      paymentId: message.payment_id as `0x${string}`,
      payer: "0x1111111111111111111111111111111111111111",
      amountUnits: 12_000_000n,
      assetCode: "USDC",
      chainId: 10_143n,
      transactionHash: message.transaction_hash as `0x${string}`,
      blockNumber: 22n,
      blockHash: `0x${"3".repeat(64)}`,
    }),
  ).resolves.toMatchObject({ paymentEntry: "ACC-PAY-0001", readBack: true });
  expect(transport.calls.map(({ method }) => method)).toEqual(["POST", "GET"]);
  expect(transport.calls[0]?.headers["Idempotency-Key"]).toBe(message.transition_id);
});
