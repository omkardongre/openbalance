import { readFile, writeFile } from "node:fs/promises";

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["FINALIZED", "REVERTED", "REJECTED"]);

function validate(config) {
  if (
    config.schemaVersion !== 1 ||
    ![10, 50, 100].includes(config.targetRatePerSecond) ||
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > 500 ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1_000 ||
    config.timeoutMs > 600_000 ||
    !Number.isInteger(config.pollIntervalMs) ||
    config.pollIntervalMs < 50 ||
    typeof config.baseUrl !== "string" ||
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
  const ids = new Set();
  for (const offer of config.offers) {
    if (!HEX_32.test(offer.paymentId) || ids.has(offer.paymentId.toLowerCase()))
      throw new Error("Invalid or duplicate payment ID");
    if (
      typeof offer.path !== "string" ||
      !offer.path.startsWith("/") ||
      offer.path.startsWith("//")
    )
      throw new Error("Invalid workload path");
    if (typeof offer.idempotencyKey !== "string" || offer.idempotencyKey.length > 128)
      throw new Error("Invalid idempotency key");
    ids.add(offer.paymentId.toLowerCase());
  }
}

async function request(config, path, init) {
  const base = new URL(config.baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.username || url.password || url.hash)
    throw new Error("Workload request must remain on the configured origin");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 30_000));
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function proofFields(value) {
  const proof = value.proof;
  if (
    !proof ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.blockHash)
  )
    throw new Error("Terminal financial outcome has no valid finalized proof");
  for (const key of ["blockNumber", "gasUsed", "effectiveGasPriceWei"])
    if (!/^(0|[1-9][0-9]*)$/.test(proof[key])) throw new Error(`Invalid finalized proof ${key}`);
  return {
    finalizedAtMs: Date.now(),
    transactionHash: proof.transactionHash.toLowerCase(),
    blockHash: proof.blockHash.toLowerCase(),
    blockNumber: proof.blockNumber,
    gasUsed: proof.gasUsed,
    effectiveGasPriceWei: proof.effectiveGasPriceWei,
  };
}

async function runOffer(config, offer, authorization) {
  const offeredAtMs = Date.now();
  const headers = { "content-type": "application/json", "idempotency-key": offer.idempotencyKey };
  if (authorization) headers.authorization = authorization;
  let response;
  try {
    response = await request(config, offer.path, {
      method: "POST",
      headers,
      body: JSON.stringify(offer.body),
    });
  } catch {
    return { paymentId: offer.paymentId.toLowerCase(), offeredAtMs, status: "PENDING" };
  }
  let value = await response.json().catch(() => ({}));
  if (response.status >= 400 && response.status < 500)
    return { paymentId: offer.paymentId.toLowerCase(), offeredAtMs, status: "REJECTED" };
  const deadline = offeredAtMs + config.timeoutMs;
  const statusPath = value.statusPath;
  while (!TERMINAL.has(value.status) && typeof statusPath === "string" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    let poll;
    try {
      poll = await request(config, statusPath, {
        method: "GET",
        headers: authorization ? { authorization } : {},
      });
    } catch {
      return { paymentId: offer.paymentId.toLowerCase(), offeredAtMs, status: "PENDING" };
    }
    value = await poll.json().catch(() => ({}));
  }
  const status = TERMINAL.has(value.status) ? value.status : "PENDING";
  return {
    paymentId: offer.paymentId.toLowerCase(),
    offeredAtMs,
    status,
    ...(status === "FINALIZED" || status === "REVERTED" ? proofFields(value) : {}),
  };
}

export async function runWorkload(config, environment = process.env) {
  validate(config);
  const authorization = config.authorizationEnv ? environment[config.authorizationEnv] : undefined;
  if (config.authorizationEnv && !authorization)
    throw new Error("Configured authorization environment variable is missing");
  const startedAtMs = Date.now();
  const results = new Array(config.offers.length);
  let cursor = 0;
  let nextOfferAt = startedAtMs;
  async function worker() {
    while (cursor < config.offers.length) {
      const index = cursor++;
      const delay = nextOfferAt - Date.now();
      nextOfferAt += 1_000 / config.targetRatePerSecond;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      results[index] = await runOffer(config, config.offers[index], authorization);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(config.concurrency, config.offers.length) }, worker),
  );
  return {
    schemaVersion: 1,
    environment: config.environment,
    chainId: config.chainId,
    contractCodeHash: config.contractCodeHash,
    startedAtMs,
    endedAtMs: Date.now(),
    payments: results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, outputPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath) {
    process.stderr.write(
      "Usage: node scripts/run-payment-workload.mjs <workload.json> <observations.json>\n",
    );
    process.exitCode = 64;
  } else {
    const config = JSON.parse(await readFile(manifestPath, "utf8"));
    const output = await runWorkload(config);
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ offers: output.payments.length, outputPath })}\n`);
  }
}
