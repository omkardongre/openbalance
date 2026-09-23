import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

const hex32 = (value) => typeof value === "string" && HEX_32.test(value);
const uint = (value) => typeof value === "string" && UINT.test(value);
const index = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Per-block settlement occupancy for one concurrent-payment run.
 *
 * Occupancy is the contention signal this aggregation exists to produce. A chain that executes
 * independent payments in parallel places many of them in one block; a workload whose transactions
 * all write a common storage slot is re-executed serially and spreads across many blocks instead.
 *
 * Only a settled payment counts toward occupancy. A reverted transaction is mined and charged, but
 * it unwinds every storage write it attempted, so it never touches the slots whose contention is
 * under measurement: counting reverts would let a wholly broken run report ideal parallelism. They
 * are still carried, both in each block's gas accounting and as an explicit `reverted` tally, so a
 * caller can refuse to treat such a run as evidence.
 *
 * The count alone cannot distinguish parallelism from a third cause, so every block additionally
 * carries its gas headroom and the run carries its offered supply:
 *
 * - low occupancy with the block near its gas limit is gas-bound, not contention-bound;
 * - low occupancy with spare gas and spare offered load is the contention signal;
 * - low occupancy with spare gas and exhausted offered load only means too little was offered.
 *
 * Attributing a difference therefore requires two runs with every other variable held fixed, which
 * is why `contractCodeHash` is mandatory and reported back.
 */
export function summarizeContention(run) {
  if (
    !run ||
    !index(run.chainId) ||
    run.chainId < 1 ||
    !index(run.startedAtMs) ||
    !index(run.endedAtMs) ||
    run.endedAtMs <= run.startedAtMs ||
    !hex32(run.contractCodeHash) ||
    !["local", "testnet", "mainnet"].includes(run.environment) ||
    !Array.isArray(run.payments) ||
    run.payments.length === 0 ||
    run.payments.length > 1_000_000 ||
    !Array.isArray(run.blocks)
  )
    throw new Error("Invalid contention run");

  const blocks = new Map();
  for (const block of run.blocks) {
    if (
      !block ||
      !uint(block.blockNumber) ||
      !uint(block.gasUsed) ||
      !uint(block.gasLimit) ||
      BigInt(block.gasLimit) === 0n ||
      BigInt(block.gasUsed) > BigInt(block.gasLimit) ||
      blocks.has(block.blockNumber)
    )
      throw new Error("Invalid or duplicate observed block");
    blocks.set(block.blockNumber, {
      blockNumber: block.blockNumber,
      gasUsed: BigInt(block.gasUsed),
      gasLimit: BigInt(block.gasLimit),
      mined: 0,
      settled: 0,
      paymentGasUsed: 0n,
    });
  }

  const seen = new Set();
  let mined = 0;
  let settled = 0;
  let reverted = 0;
  for (const payment of run.payments) {
    if (!payment || !hex32(payment.paymentId) || seen.has(payment.paymentId.toLowerCase()))
      throw new Error("Invalid or duplicate payment observation");
    seen.add(payment.paymentId.toLowerCase());
    if (payment.status !== "FINALIZED" && payment.status !== "REVERTED") continue;
    if (!uint(payment.blockNumber) || !uint(payment.gasUsed))
      throw new Error("Mined observations require a block number and gas accounting");
    const block = blocks.get(payment.blockNumber);
    // A mined payment whose block was never observed would silently shrink the denominator.
    if (!block) throw new Error(`Mined payment references unobserved block ${payment.blockNumber}`);
    block.mined += 1;
    block.paymentGasUsed += BigInt(payment.gasUsed);
    mined += 1;
    if (payment.status === "FINALIZED") {
      block.settled += 1;
      settled += 1;
    } else reverted += 1;
  }

  const occupied = [...blocks.values()].filter((block) => block.mined > 0);
  if (occupied.length === 0) throw new Error("Run contains no mined payment to attribute");
  const settledBlocks = occupied.filter((block) => block.settled > 0);
  if (settledBlocks.length === 0)
    throw new Error(
      `Run settled no payment: ${reverted} of ${mined} mined transactions reverted, so no ` +
        "contended slot was ever written and the run carries no information about contention",
    );
  const counts = settledBlocks.map((block) => block.settled).sort((a, b) => a - b);
  const seconds = (run.endedAtMs - run.startedAtMs) / 1_000;
  const ratio = (numerator, denominator) => Number((numerator * 1_000_000n) / denominator) / 1e6;
  const peak = settledBlocks.reduce((a, b) => (b.settled > a.settled ? b : a));

  return {
    schemaVersion: 2,
    environment: run.environment,
    chainId: run.chainId,
    contractCodeHash: run.contractCodeHash,
    startedAtMs: run.startedAtMs,
    endedAtMs: run.endedAtMs,
    offered: run.payments.length,
    mined,
    settled,
    reverted,
    observedBlocks: blocks.size,
    occupiedBlocks: occupied.length,
    settledBlocks: settledBlocks.length,
    settledPerSecond: settled / seconds,
    minedPerSecond: mined / seconds,
    settledPerSettledBlock: {
      min: counts[0],
      median: counts[Math.ceil(counts.length / 2) - 1],
      max: counts[counts.length - 1],
      mean: settled / settledBlocks.length,
    },
    // Measured at the busiest block, where a gas ceiling would bind first if one were binding.
    peakBlock: {
      blockNumber: peak.blockNumber,
      settled: peak.settled,
      mined: peak.mined,
      gasUtilization: ratio(peak.gasUsed, peak.gasLimit),
      paymentGasShare: ratio(peak.paymentGasUsed, peak.gasLimit),
    },
    maxGasUtilizationAcrossOccupiedBlocks: occupied.reduce(
      (max, block) => Math.max(max, ratio(block.gasUsed, block.gasLimit)),
      0,
    ),
    blocks: occupied.map((block) => ({
      blockNumber: block.blockNumber,
      settled: block.settled,
      mined: block.mined,
      gasUtilization: ratio(block.gasUsed, block.gasLimit),
      paymentGasShare: ratio(block.paymentGasUsed, block.gasLimit),
    })),
    attribution:
      "Occupancy is comparable only between runs that differ solely in contractCodeHash. " +
      "A difference is evidence of storage-slot contention only while gas utilization stays " +
      "below the block ceiling, offered load exceeds settled load in both runs, and `reverted` " +
      "is zero in both: a reverted payment writes no contended slot and inflates apparent " +
      "parallelism.",
    limitation:
      "Optimistic execution re-executes a conflicting transaction but still commits it in the " +
      "same block, so occupancy is insensitive to contention at any offered load the node can " +
      "absorb. A single burst below saturation is therefore expected to show no difference even " +
      "when contention is real. Attribution requires a rising-load series where settledPerSecond " +
      "is compared at the point it stops tracking the offered rate.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3)
      throw new Error("Usage: contention-metrics.mjs observations.json");
    const file = await readFile(process.argv[2]);
    if (file.length > 64 * 1024 * 1024) throw new Error("Contention input exceeds limit");
    console.log(JSON.stringify(summarizeContention(JSON.parse(file.toString("utf8"))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid contention input");
    process.exitCode = 1;
  }
}
