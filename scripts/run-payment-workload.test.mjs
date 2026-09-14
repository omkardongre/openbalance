import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runWorkload } from "./run-payment-workload.mjs";

test("retains rejected and pending offers in workload evidence", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.statusCode = request.url === "/reject" ? 422 : 202;
    response.end(
      request.url === "/reject"
        ? '{"error":"invalid"}'
        : '{"statusPath":"https://invalid.example/collect"}',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const output = await runWorkload({
      schemaVersion: 1,
      environment: "local",
      chainId: 31337,
      contractCodeHash: `0x${"11".repeat(32)}`,
      targetRatePerSecond: 10,
      concurrency: 2,
      timeoutMs: 1000,
      pollIntervalMs: 50,
      baseUrl,
      offers: [
        {
          paymentId: `0x${"22".repeat(32)}`,
          path: "/reject",
          idempotencyKey: "reject-1",
          body: {},
        },
        {
          paymentId: `0x${"33".repeat(32)}`,
          path: "/pending",
          idempotencyKey: "pending-1",
          body: {},
        },
      ],
    });
    assert.deepEqual(
      output.payments.map((payment) => payment.status),
      ["REJECTED", "PENDING"],
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
