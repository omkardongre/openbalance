import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** One record per offered payment, including failures and unresolved submissions. */
export function summarizePayments(run) {
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const hex32 = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
  const units = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value);
  if (
    !run ||
    !integer(run.chainId) ||
    run.chainId < 1 ||
    !integer(run.startedAtMs) ||
    !integer(run.endedAtMs) ||
    run.endedAtMs <= run.startedAtMs ||
    !hex32(run.contractCodeHash) ||
    !Array.isArray(run.payments) ||
    run.payments.length === 0 ||
    run.payments.length > 1_000_000 ||
    !["local", "testnet", "mainnet"].includes(run.environment)
  )
    throw new Error("Invalid measurement run");
  const counts = { FINALIZED: 0, REVERTED: 0, REJECTED: 0, PENDING: 0 };
  const seen = new Set();
  const latencies = [];
  let gasUnits = 0n;
  let gasCostWei = 0n;
  for (const payment of run.payments) {
    if (
      !payment ||
      !hex32(payment.paymentId) ||
      seen.has(payment.paymentId.toLowerCase()) ||
      !Object.hasOwn(counts, payment.status) ||
      !integer(payment.offeredAtMs) ||
      payment.offeredAtMs < run.startedAtMs ||
      payment.offeredAtMs > run.endedAtMs
    )
      throw new Error("Invalid or duplicate payment observation");
    seen.add(payment.paymentId.toLowerCase());
    counts[payment.status]++;
    const mined = payment.status === "FINALIZED" || payment.status === "REVERTED";
    if (mined) {
      if (
        !integer(payment.finalizedAtMs) ||
        payment.finalizedAtMs < payment.offeredAtMs ||
        payment.finalizedAtMs > run.endedAtMs ||
        !hex32(payment.transactionHash) ||
        !hex32(payment.blockHash) ||
        !units(payment.blockNumber) ||
        !units(payment.gasUsed) ||
        !units(payment.effectiveGasPriceWei)
      )
        throw new Error("Mined observations require finalized proof and gas accounting");
      gasUnits += BigInt(payment.gasUsed);
      gasCostWei += BigInt(payment.gasUsed) * BigInt(payment.effectiveGasPriceWei);
      if (payment.status === "FINALIZED")
        latencies.push(payment.finalizedAtMs - payment.offeredAtMs);
    } else if (
      payment.finalizedAtMs != null ||
      payment.gasUsed != null ||
      payment.blockHash != null
    ) {
      throw new Error("Unfinalized observations cannot claim finality or confirmed gas");
    }
  }
  latencies.sort((a, b) => a - b);
  const percentile = (fraction) =>
    latencies.length ? latencies[Math.ceil(latencies.length * fraction) - 1] : null;
  const seconds = (run.endedAtMs - run.startedAtMs) / 1_000;
  return {
    schemaVersion: 1,
    environment: run.environment,
    chainId: run.chainId,
    contractCodeHash: run.contractCodeHash,
    startedAtMs: run.startedAtMs,
    endedAtMs: run.endedAtMs,
    offered: run.payments.length,
    counts,
    offeredPerSecond: run.payments.length / seconds,
    finalizedPerSecond: counts.FINALIZED / seconds,
    finalizedFractionOfOffered: counts.FINALIZED / run.payments.length,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    confirmedGasUnits: gasUnits.toString(),
    confirmedGasCostWei: gasCostWei.toString(),
    pendingCostUnknown: counts.PENDING > 0,
    proofScope: "Aggregated supplied observations; chain proofs require independent verification.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: payment-metrics.mjs observations.json");
    const file = await readFile(process.argv[2]);
    if (file.length > 64 * 1024 * 1024) throw new Error("Measurement input exceeds limit");
    console.log(JSON.stringify(summarizePayments(JSON.parse(file.toString("utf8"))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid measurement input");
    process.exitCode = 1;
  }
}
