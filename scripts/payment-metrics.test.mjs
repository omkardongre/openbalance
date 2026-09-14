import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizePayments } from "./payment-metrics.mjs";

const hash = (n) => `0x${n.repeat(64)}`;
function measurement() {
  return {
    chainId: 31337,
    environment: "local",
    contractCodeHash: hash("a"),
    startedAtMs: 0,
    endedAtMs: 10_000,
    payments: [
      {
        paymentId: hash("1"),
        status: "FINALIZED",
        offeredAtMs: 100,
        finalizedAtMs: 1_100,
        transactionHash: hash("b"),
        blockHash: hash("c"),
        blockNumber: "10",
        gasUsed: "100",
        effectiveGasPriceWei: "3",
      },
      {
        paymentId: hash("2"),
        status: "REVERTED",
        offeredAtMs: 200,
        finalizedAtMs: 1_200,
        transactionHash: hash("d"),
        blockHash: hash("c"),
        blockNumber: "10",
        gasUsed: "50",
        effectiveGasPriceWei: "3",
      },
      { paymentId: hash("3"), status: "PENDING", offeredAtMs: 500 },
      { paymentId: hash("4"), status: "REJECTED", offeredAtMs: 600 },
    ],
  };
}

test("retains failures in the denominator and reverted gas in exact totals", () => {
  const report = summarizePayments(measurement());
  assert.equal(report.finalizedFractionOfOffered, 0.25);
  assert.equal(report.finalizedPerSecond, 0.1);
  assert.equal(report.confirmedGasCostWei, "450");
  assert.equal(report.pendingCostUnknown, true);
  assert.deepEqual(report.latencyMs, { p50: 1000, p95: 1000, p99: 1000 });
});

test("rejects duplicate attempts, missing proof, and observations beyond the run", () => {
  for (const mutate of [
    (run) => {
      run.payments.push(run.payments[0]);
    },
    (run) => {
      delete run.payments[0].blockHash;
    },
    (run) => {
      run.payments[0].finalizedAtMs = 20_000;
    },
  ]) {
    const run = measurement();
    mutate(run);
    assert.throws(() => summarizePayments(run));
  }
});
