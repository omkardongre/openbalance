import { readFile, writeFile } from "node:fs/promises";

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

function validate(config) {
  if (
    config.schemaVersion !== 1 ||
    typeof config.environment !== "string" ||
    typeof config.baseUrl !== "string" ||
    !Array.isArray(config.stages) ||
    config.stages.length === 0 ||
    !config.thresholds ||
    !Array.isArray(config.offers) ||
    config.offers.length === 0
  )
    throw new Error("Invalid workload configuration");
  const origin = new URL(config.baseUrl);
  if (
    !/^https?:$/.test(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid workload base URL");
  for (const stage of config.stages) {
    if (
      typeof stage.name !== "string" ||
      !Number.isInteger(stage.targetRatePerSecond) ||
      stage.targetRatePerSecond < 1 ||
      stage.targetRatePerSecond > 1_000 ||
      !Number.isInteger(stage.durationSeconds) ||
      stage.durationSeconds < 1 ||
      stage.durationSeconds > 600 ||
      !Number.isInteger(stage.concurrency) ||
      stage.concurrency < 1 ||
      stage.concurrency > 500
    )
      throw new Error("Invalid workload stage");
  }
  for (const key of ["p95Ms", "p99Ms"])
    if (!Number.isFinite(config.thresholds[key]) || config.thresholds[key] <= 0)
      throw new Error(`Invalid workload threshold ${key}`);
  if (
    !Number.isFinite(config.thresholds.errorRate) ||
    config.thresholds.errorRate < 0 ||
    config.thresholds.errorRate > 1
  )
    throw new Error("Invalid workload error-rate threshold");
  for (const offer of config.offers) {
    if (
      typeof offer.path !== "string" ||
      !offer.path.startsWith("/") ||
      offer.path.startsWith("//")
    )
      throw new Error("Invalid workload path");
    if (offer.method !== undefined && !["GET", "POST"].includes(offer.method))
      throw new Error("Invalid workload method");
  }
}

/** Nearest-rank percentile over an ascending sample array. */
export function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarise(samples) {
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const errors = samples.filter((sample) => sample.error).length;
  return {
    count: samples.length,
    errorCount: errors,
    errorRate: samples.length === 0 ? 0 : errors / samples.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? 0,
  };
}

function withinThresholds(summary, thresholds) {
  return (
    summary.p95Ms <= thresholds.p95Ms &&
    summary.p99Ms <= thresholds.p99Ms &&
    summary.errorRate <= thresholds.errorRate
  );
}

async function request(config, offer, authorization, fetchImpl) {
  const base = new URL(config.baseUrl);
  const url = new URL(offer.path, base);
  if (url.origin !== base.origin) throw new Error("Workload request escaped the configured origin");
  const headers = { ...(offer.headers ?? {}) };
  if (authorization) headers.authorization = authorization;
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: offer.method ?? "GET",
      headers,
      ...(offer.body === undefined ? {} : { body: JSON.stringify(offer.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
    return { latencyMs: performance.now() - started, error: response.status >= 400 };
  } catch {
    return { latencyMs: performance.now() - started, error: true };
  }
}

async function runStage(config, stage, authorization, fetchImpl) {
  const samples = [];
  const total = stage.targetRatePerSecond * stage.durationSeconds;
  const intervalMs = 1_000 / stage.targetRatePerSecond;
  let cursor = 0;
  let nextAt = performance.now();
  async function worker() {
    while (cursor < total) {
      const index = cursor++;
      const offer = config.offers[index % config.offers.length];
      const delay = nextAt - performance.now();
      nextAt += intervalMs;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      samples[index] = await request(config, offer, authorization, fetchImpl);
    }
  }
  await Promise.all(Array.from({ length: Math.min(stage.concurrency, total) }, () => worker()));
  return summarise(samples);
}

/**
 * Runs smoke, load and stress stages at the configured arrival rate and asserts latency and
 * error-rate thresholds. Stops at the first failing stage so a broken level is not masked by a
 * later one. Every stage's summary is returned as reproducible evidence.
 */
export async function runSloWorkload(config, environment = process.env, fetchImpl = fetch) {
  validate(config);
  const authorization = config.authorizationEnv ? environment[config.authorizationEnv] : undefined;
  if (config.authorizationEnv && !authorization)
    throw new Error("Configured authorization environment variable is missing");
  const stages = [];
  for (const stage of config.stages) {
    const summary = await runStage(config, stage, authorization, fetchImpl);
    const passed = withinThresholds(summary, config.thresholds);
    stages.push({
      name: stage.name,
      targetRatePerSecond: stage.targetRatePerSecond,
      ...summary,
      passed,
    });
    if (!passed) break;
  }
  return {
    schemaVersion: 1,
    environment: config.environment,
    baseUrl: config.baseUrl,
    thresholds: config.thresholds,
    stages,
    passed: stages.length === config.stages.length && stages.every((stage) => stage.passed),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [configPath, outputPath] = process.argv.slice(2);
  if (!configPath || !outputPath) {
    process.stderr.write(
      "Usage: node scripts/slo-workload.mjs <config.json> <observations.json>\n",
    );
    process.exitCode = 64;
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const observations = await runSloWorkload(config);
    await writeFile(outputPath, `${JSON.stringify(observations, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(
      `${JSON.stringify({ passed: observations.passed, stages: observations.stages.length, outputPath })}\n`,
    );
    if (!observations.passed) process.exitCode = 1;
  }
}
