import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile, runSloWorkload, summarise } from "./slo-workload.mjs";

const config = {
  schemaVersion: 1,
  environment: "local",
  baseUrl: "http://127.0.0.1:3001",
  timeoutMs: 2_000,
  thresholds: { p95Ms: 1_000, p99Ms: 2_000, errorRate: 0.01 },
  stages: [{ name: "smoke", targetRatePerSecond: 20, durationSeconds: 1, concurrency: 4 }],
  offers: [{ path: "/health/live" }],
};

test("computes nearest-rank percentiles", () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([], 0.95), 0);
  assert.deepEqual(
    summarise([
      { latencyMs: 10, error: false },
      { latencyMs: 30, error: true },
    ]),
    {
      count: 2,
      errorCount: 1,
      errorRate: 0.5,
      p50Ms: 10,
      p95Ms: 30,
      p99Ms: 30,
      maxMs: 30,
    },
  );
});

test("passes when every stage stays inside the thresholds", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200 });
  const result = await runSloWorkload(config, {}, fetchImpl);
  assert.equal(result.passed, true);
  assert.equal(result.stages[0].errorRate, 0);
});

test("fails and stops when a stage breaches the error-rate ceiling", async () => {
  const fetchImpl = async () => new Response("{}", { status: 503 });
  const failing = {
    ...config,
    stages: [
      { name: "smoke", targetRatePerSecond: 10, durationSeconds: 1, concurrency: 2 },
      { name: "load", targetRatePerSecond: 10, durationSeconds: 1, concurrency: 2 },
    ],
  };
  const result = await runSloWorkload(failing, {}, fetchImpl);
  assert.equal(result.passed, false);
  assert.equal(result.stages.length, 1);
  assert.equal(result.stages[0].errorRate, 1);
});

test("rejects a configuration that escapes the configured origin", async () => {
  const result = await runSloWorkload(
    { ...config, offers: [{ path: "https://evil.example/steal" }] },
    {},
    async () => new Response("{}", { status: 200 }),
  ).catch((error) => error);
  assert.ok(result instanceof Error);
});
