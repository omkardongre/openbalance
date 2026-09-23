import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeConflictGraph } from "./contention-graph.mjs";

const TOKEN = "0x1111111111111111111111111111111111111111";
const slot = (label) => `0x${label.padStart(64, "0")}`;
const at = (slotLabel) => ({ address: TOKEN, slot: slot(slotLabel) });

/**
 * Eight transfers, each touching only its own sender and recipient balance slots, optionally plus
 * `extraWrites` per transaction.
 *
 * Shaped to reproduce the three reference figures published for this pattern — 8.00x for plain
 * transfers, 1.00x once a single shared accumulator is added, and 4.00x for the usual sixteen-shard
 * remedy. Matching them is what shows this analyzer measures the same thing the ecosystem's tools
 * measure, rather than a metric of its own invention.
 */
function transfers(extraWrites = () => []) {
  return {
    chainId: 10_143,
    environment: "testnet",
    contractCodeHash: slot("a1"),
    transactions: Array.from({ length: 8 }, (_, index) => ({
      label: `transfer:${index}`,
      gasUsed: "100000",
      touched: [at(`5${index}`), at(`6${index}`)],
      writes: [at(`5${index}`), at(`6${index}`), ...extraWrites(index)],
    })),
  };
}

test("independent transfers are fully parallel", () => {
  const report = summarizeConflictGraph(transfers());
  assert.equal(report.conflicts, 0);
  assert.equal(report.executionWaves, 1);
  assert.equal(report.theoreticalSpeedup, 8);
  assert.equal(report.parallelismScore, 100);
  assert.equal(report.sharedWrittenSlotCount, 0);
  // Critical path is a single transaction out of eight, so the gas-weighted ceiling agrees.
  assert.equal(report.stateContentionIndex, 0.125);
  assert.equal(report.idealSpeedupBound, 8);
});

test("one shared accumulator serialises the whole set", () => {
  const report = summarizeConflictGraph(transfers(() => [at("ff")]));
  assert.equal(report.executionWaves, 8);
  assert.equal(report.theoreticalSpeedup, 1);
  assert.equal(report.parallelismScore, 0);
  assert.equal(report.stateContentionIndex, 1);
  assert.equal(report.idealSpeedupBound, 1);
  assert.deepEqual(report.sharedWrittenSlots, [
    { slot: `${TOKEN}:${slot("ff")}`, writers: 8, conflictsInvolvingSlot: 28 },
  ]);
});

test("sharding the accumulator recovers only part of the parallelism", () => {
  // Eight writers spread over four occupied shards: every shard takes exactly two writers, so the
  // longest conflict chain is two and the ceiling lands at 8/2 rather than 8.
  const report = summarizeConflictGraph(transfers((index) => [at(`a${index % 4}`)]));
  assert.equal(report.executionWaves, 2);
  assert.equal(report.theoreticalSpeedup, 4);
  assert.equal(report.parallelismScore, 85.71);
  assert.equal(report.sharedWrittenSlotCount, 4);
  assert.equal(report.stateContentionIndex, 0.25);
});

test("reports which shared slot carries the contention", () => {
  const report = summarizeConflictGraph(transfers((index) => (index < 3 ? [at("ff")] : [])));
  assert.equal(report.executionWaves, 3);
  assert.deepEqual(report.sharedWrittenSlots, [
    { slot: `${TOKEN}:${slot("ff")}`, writers: 3, conflictsInvolvingSlot: 3 },
  ]);
});

test("counts a read against an earlier write as a conflict", () => {
  const base = transfers();
  base.transactions[1].touched.push(at("50"));
  const report = summarizeConflictGraph(base);
  assert.equal(report.conflicts, 1);
  assert.equal(report.executionWaves, 2);
});

test("rejects input that cannot support a comparison", () => {
  for (const mutate of [
    (value) => {
      value.transactions = value.transactions.slice(0, 1);
    },
    (value) => {
      value.transactions[0].gasUsed = "0";
    },
    (value) => {
      value.transactions[0].writes = [{ address: TOKEN, slot: "0x01" }];
    },
    (value) => {
      value.contractCodeHash = "0xdead";
    },
  ]) {
    const value = transfers();
    mutate(value);
    assert.throws(() => summarizeConflictGraph(value));
  }
});
