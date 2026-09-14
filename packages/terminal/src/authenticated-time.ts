import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { TrustedTimeSample } from "./clock.js";
import { UntrustedTerminalTime } from "./clock.js";
import type { AuthenticatedTimeSource, DeviceMonotonicClock } from "./device.js";

/** A provisioned time authority signs this exact UTF-8 payload with Ed25519. */
export function timeAttestationPayload(input: {
  nonce: string;
  unixMs: number;
  uncertaintyMs: number;
}): string {
  if (
    !/^[a-f0-9]{64}$/.test(input.nonce) ||
    !Number.isSafeInteger(input.unixMs) ||
    input.unixMs < 0 ||
    !Number.isSafeInteger(input.uncertaintyMs) ||
    input.uncertaintyMs < 0
  )
    throw new UntrustedTerminalTime("Invalid time attestation");
  return JSON.stringify({
    domain: "openbalance:terminal-time:v1",
    nonce: input.nonce,
    unixMs: input.unixMs,
    uncertaintyMs: input.uncertaintyMs,
  });
}

/** Pin the authority key independently of the response. Never use the device wall clock. */
export class SignedHttpsTimeSource implements AuthenticatedTimeSource {
  readonly #key;
  readonly #url: URL;

  constructor(
    endpoint: string,
    publicKeyPem: string,
    private readonly clock: DeviceMonotonicClock,
    private readonly maximumRoundTripMs = 5_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.#url = new URL(endpoint);
    this.#key = createPublicKey(publicKeyPem);
    if (
      this.#url.protocol !== "https:" ||
      this.#url.username ||
      this.#url.password ||
      this.#url.hash ||
      this.#url.search ||
      this.#key.asymmetricKeyType !== "ed25519" ||
      !Number.isSafeInteger(maximumRoundTripMs) ||
      maximumRoundTripMs < 1 ||
      maximumRoundTripMs > 30_000
    )
      throw new UntrustedTerminalTime("Invalid authenticated time configuration");
  }

  async sample(): Promise<TrustedTimeSample> {
    const nonce = randomBytes(32).toString("hex");
    const before = this.clock.read();
    const response = await this.fetcher(this.#url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(this.maximumRoundTripMs),
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json") ||
      !response.body
    )
      throw new UntrustedTerminalTime("Time authority unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 2_048) throw new UntrustedTerminalTime("Time response exceeds limit");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "nonce,signature,uncertaintyMs,unixMs" ||
      data.nonce !== nonce ||
      typeof data.signature !== "string" ||
      !/^[a-f0-9]{128}$/.test(data.signature)
    )
      throw new UntrustedTerminalTime("Time attestation mismatch");
    const payload = timeAttestationPayload(data);
    if (!verify(null, Buffer.from(payload), this.#key, Buffer.from(data.signature, "hex")))
      throw new UntrustedTerminalTime("Time attestation signature rejected");
    const after = this.clock.read();
    const elapsed = after.monotonicMs - before.monotonicMs;
    if (
      !before.bootId ||
      after.bootId !== before.bootId ||
      !Number.isSafeInteger(before.monotonicMs) ||
      !Number.isSafeInteger(after.monotonicMs) ||
      before.monotonicMs < 0 ||
      elapsed < 0 ||
      elapsed > this.maximumRoundTripMs
    )
      throw new UntrustedTerminalTime("Time request lost clock continuity");
    const earliestUnixMs = data.unixMs - data.uncertaintyMs;
    const latestUnixMs = data.unixMs + data.uncertaintyMs + elapsed;
    if (
      earliestUnixMs < 0 ||
      !Number.isSafeInteger(earliestUnixMs) ||
      !Number.isSafeInteger(latestUnixMs)
    )
      throw new UntrustedTerminalTime("Invalid time bounds");
    return {
      earliestUnixMs,
      latestUnixMs,
      observedMonotonicMs: after.monotonicMs,
      bootId: after.bootId,
    };
  }
}
