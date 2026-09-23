// Transaction conflict graph for a set of payments executed from one common pre-state.
//
// This is the measurement that actually answers "does this contract get parallelism on Monad", and
// it answers it without needing to saturate a network. Monad's documented model is optimistic: a
// transaction is re-executed when an input it read differs from an output an earlier transaction in
// the block wrote (monad-arch/execution/parallel-execution). Available parallelism is therefore a
// property of the storage-slot access pattern of the contracts, and that pattern can be extracted
// by simulation.
//
// Two metric families are emitted rather than one, because two independent tools in this ecosystem
// already publish these and a number nobody can cross-check is worth little:
//
//   - Execution waves and a 0-100 parallelism score, as the Monad block visualiser `pev` reports
//     them: the minimum number of sequential rounds the set needs given its conflicts.
//   - State Contention Index and its implied speedup ceiling, as the `slotscope` profiler defines
//     them: SCI = critical-path gas / total workload gas, ideal speedup bound = 1 / SCI.
//
// Both are ceilings on what any scheduler could extract, not predictions of what Monad's scheduler
// does — that decision is internal and not exposed over RPC. Monad's docs also note that a
// re-executed transaction keeps its cached state and its signature recovery, so a conflict costs
// less than a full serial execution. Waves therefore overstate the harm, which is the safe
// direction for a claim of improvement: the measured gain is a lower bound on nothing and an upper
// bound on everything, and must be described as a structural property, never as throughput.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

const uint = (value) => typeof value === "string" && UINT.test(value);

/** `address:slot`, lower-cased, so the same slot from two traces is one graph key. */
function accessKey(access, field) {
  if (
    !access ||
    typeof access.address !== "string" ||
    !ADDRESS.test(access.address) ||
    typeof access.slot !== "string" ||
    !HEX_32.test(access.slot)
  )
    throw new Error(`Invalid ${field} access: expected a 20-byte address and a 32-byte slot`);
  return `${access.address.toLowerCase()}:${access.slot.toLowerCase()}`;
}

function accessSet(values, field) {
  const set = new Set();
  if (!Array.isArray(values)) throw new Error(`Transaction ${field} must be an array`);
  for (const value of values) set.add(accessKey(value, field));
  return set;
}

/**
 * Build the conflict graph for `input.transactions` and report its parallelism ceilings.
 *
 * Every transaction is simulated against the same pre-state, which is what makes this the right
 * question to ask: it is the state each of them would see if a block scheduler started all of them
 * at once. Conflicts are oriented by transaction index, matching the fact that Monad merges state
 * updates in block order, so the graph is acyclic and a longest path is well defined.
 */
export function summarizeConflictGraph(input) {
  if (
    !input ||
    !Number.isSafeInteger(input.chainId) ||
    input.chainId < 1 ||
    typeof input.contractCodeHash !== "string" ||
    !HEX_32.test(input.contractCodeHash) ||
    !["local", "testnet", "mainnet"].includes(input.environment) ||
    !Array.isArray(input.transactions) ||
    input.transactions.length < 2 ||
    input.transactions.length > 10_000
  )
    throw new Error("Invalid conflict graph input: at least two transactions are required");

  const transactions = input.transactions.map((transaction, index) => {
    if (!transaction || typeof transaction.label !== "string" || !transaction.label)
      throw new Error(`Transaction ${index} needs a label`);
    if (!uint(transaction.gasUsed) || BigInt(transaction.gasUsed) === 0n)
      throw new Error(`Transaction ${index} needs non-zero gasUsed to weight the critical path`);
    const writes = accessSet(transaction.writes, "writes");
    // A written slot was necessarily touched. Normalising here means a caller may report `touched`
    // as either all accesses or only the read-but-not-written ones without changing the result.
    const touched = new Set([...accessSet(transaction.touched, "touched"), ...writes]);
    return { index, label: transaction.label, gas: BigInt(transaction.gasUsed), writes, touched };
  });

  // Conflict edges, oriented earlier -> later. An edge exists when the pair shares a slot and at
  // least one of them writes it: read-after-write and write-after-write are what force a re-run,
  // and write-after-read is included because the earlier reader's inputs are what the later
  // writer's output would invalidate had the order been reversed.
  const conflicts = [];
  const slotConflicts = new Map();
  const predecessors = transactions.map(() => []);
  for (let later = 0; later < transactions.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = transactions[earlier];
      const b = transactions[later];
      const slots = [];
      for (const slot of a.writes) if (b.touched.has(slot)) slots.push(slot);
      for (const slot of b.writes) if (a.touched.has(slot) && !a.writes.has(slot)) slots.push(slot);
      if (slots.length === 0) continue;
      const unique = [...new Set(slots)].sort();
      conflicts.push({ earlier, later, slots: unique });
      predecessors[later].push(earlier);
      for (const slot of unique) slotConflicts.set(slot, (slotConflicts.get(slot) ?? 0) + 1);
    }
  }

  // Waves and critical path in one pass: index order is already a topological order.
  const wave = new Array(transactions.length).fill(1);
  const criticalPathGas = transactions.map((transaction) => transaction.gas);
  for (const transaction of transactions) {
    for (const earlier of predecessors[transaction.index]) {
      wave[transaction.index] = Math.max(wave[transaction.index], wave[earlier] + 1);
      criticalPathGas[transaction.index] = bigMax(
        criticalPathGas[transaction.index],
        criticalPathGas[earlier] + transaction.gas,
      );
    }
  }

  const count = transactions.length;
  const waves = Math.max(...wave);
  const totalGas = transactions.reduce((total, transaction) => total + transaction.gas, 0n);
  const criticalGas = criticalPathGas.reduce((max, value) => bigMax(max, value), 0n);
  const sci = ratio(criticalGas, totalGas);

  // Slots that more than one transaction writes are the ones a redesign can remove. Reported with
  // how many transactions write them, because that count is what the wave depth follows.
  const writers = new Map();
  for (const transaction of transactions)
    for (const slot of transaction.writes) writers.set(slot, (writers.get(slot) ?? 0) + 1);
  const sharedWrittenSlots = [...writers.entries()]
    .filter(([, count_]) => count_ > 1)
    .map(([slot, writerCount]) => ({
      slot,
      writers: writerCount,
      conflictsInvolvingSlot: slotConflicts.get(slot) ?? 0,
    }))
    .sort((a, b) => b.writers - a.writers || a.slot.localeCompare(b.slot));

  return {
    schemaVersion: 1,
    environment: input.environment,
    chainId: input.chainId,
    contractCodeHash: input.contractCodeHash,
    transactions: count,
    // Every transaction writes at least the slots it must; a set with no conflict at all is the
    // ideal and is reported as one wave rather than treated as an error.
    conflicts: conflicts.length,
    executionWaves: waves,
    // Serial would need one wave per transaction, so this is how much better the conflict
    // structure could allow a scheduler to do. Unweighted, to match how `pev` reports it.
    theoreticalSpeedup: count / waves,
    // 100 when every transaction is independent, 0 when the set is fully serialised. Stated as a
    // formula rather than a grade so the number cannot be reinterpreted later.
    parallelismScore:
      count > 1 ? Math.round((100 * (count - waves) * 100) / (count - 1)) / 100 : 100,
    parallelismScoreFormula: "100 * (transactions - executionWaves) / (transactions - 1)",
    totalGas: totalGas.toString(),
    criticalPathGas: criticalGas.toString(),
    stateContentionIndex: sci,
    idealSpeedupBound: sci > 0 ? 1 / sci : count,
    sharedWrittenSlots,
    sharedWrittenSlotCount: sharedWrittenSlots.length,
    // Capped so a wide run cannot turn the evidence file into something nobody will read; the
    // aggregate counts above are complete regardless.
    conflictSample: conflicts.slice(0, 200),
    method:
      "Every transaction was simulated against one common pre-state and its storage accesses " +
      "extracted from prestateTracer output. An edge joins two transactions that touch the same " +
      "(address, slot) where at least one writes it, oriented by index because Monad merges state " +
      "updates in block order.",
    limitation:
      "executionWaves, theoreticalSpeedup, parallelismScore and idealSpeedupBound are ceilings " +
      "implied by the conflict structure, not throughput measurements: Monad's scheduler decisions " +
      "are internal and not exposed over RPC, and a re-executed transaction retains cached state " +
      "and signature recovery, so a conflict costs less than a full serial execution. Comparable " +
      "only between runs that differ solely in contractCodeHash and hold the payment count fixed.",
  };
}

function bigMax(a, b) {
  return a > b ? a : b;
}

function ratio(numerator, denominator) {
  if (denominator === 0n) throw new Error("Cannot compute a ratio against zero total gas");
  return Number((numerator * 1_000_000n) / denominator) / 1e6;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: contention-graph.mjs accesses.json");
    const file = await readFile(process.argv[2]);
    if (file.length > 64 * 1024 * 1024) throw new Error("Conflict graph input exceeds limit");
    console.log(JSON.stringify(summarizeConflictGraph(JSON.parse(file.toString("utf8"))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid conflict graph input");
    process.exitCode = 1;
  }
}
