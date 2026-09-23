import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeContention } from "./contention-metrics.mjs";

const hash = (n) => `0x${n.repeat(64)}`;

function mined(id, blockNumber) {
  return { paymentId: hash(id), status: "FINALIZED", blockNumber, gasUsed: "100000" };
}

function run() {
  return {
    chainId: 10143,
    environment: "testnet",
    contractCodeHash: hash("a"),
    startedAtMs: 0,
    endedAtMs: 4_000,
    blocks: [
      { blockNumber: "10", gasUsed: "300000", gasLimit: "150000000" },
      { blockNumber: "11", gasUsed: "100000", gasLimit: "150000000" },
      { blockNumber: "12", gasUsed: "0", gasLimit: "150000000" },
    ],
    payments: [
      mined("1", "10"),
      mined("2", "10"),
      mined("3", "10"),
      mined("4", "11"),
      { paymentId: hash("5"), status: "PENDING" },
    ],
  };
}

test("attributes occupancy per block and keeps the gas ceiling visible", () => {
  const report = summarizeContention(run());
  assert.equal(report.mined, 4);
  assert.equal(report.settled, 4);
  assert.equal(report.reverted, 0);
  assert.equal(report.offered, 5);
  assert.equal(report.observedBlocks, 3);
  assert.equal(report.occupiedBlocks, 2);
  assert.equal(report.settledBlocks, 2);
  assert.equal(report.settledPerSecond, 1);
  assert.deepEqual(report.settledPerSettledBlock, { min: 1, median: 1, max: 3, mean: 2 });
  assert.equal(report.peakBlock.blockNumber, "10");
  assert.equal(report.peakBlock.settled, 3);
  // Spare gas at the busiest block is what makes a low occupancy attributable to contention.
  assert.equal(report.maxGasUtilizationAcrossOccupiedBlocks, 0.002);
});

test("counts a revert as mined but never as settled", () => {
  const value = run();
  value.payments[0].status = "REVERTED";
  const report = summarizeContention(value);
  assert.equal(report.mined, 4);
  assert.equal(report.settled, 3);
  assert.equal(report.reverted, 1);
  // Block 10 mined three payments but settled only two, so occupancy must read two.
  assert.equal(report.peakBlock.settled, 2);
  assert.equal(report.peakBlock.mined, 3);
});

test("refuses a run in which every payment reverted", () => {
  const value = run();
  for (const payment of value.payments) if (payment.blockNumber) payment.status = "REVERTED";
  assert.throws(() => summarizeContention(value), /settled no payment/);
});

test("rejects a mined payment whose block was never observed", () => {
  const value = run();
  value.payments.push(mined("6", "99"));
  assert.throws(() => summarizeContention(value), /unobserved block 99/);
});

test("rejects duplicate payments, duplicate blocks, and gas above the limit", () => {
  for (const mutate of [
    (value) => value.payments.push(value.payments[0]),
    (value) => value.blocks.push(value.blocks[0]),
    (value) => {
      value.blocks[0].gasUsed = "150000001";
    },
  ]) {
    const value = run();
    mutate(value);
    assert.throws(() => summarizeContention(value));
  }
});
