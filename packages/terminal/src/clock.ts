/** The host must authenticate the time sample and supply a suspend-aware monotonic clock. */
export type TrustedTimeSample = {
  earliestUnixMs: number;
  latestUnixMs: number;
  observedMonotonicMs: number;
  bootId: string;
};

export class UntrustedTerminalTime extends Error {}

export class TerminalClock {
  readonly #sample: TrustedTimeSample;
  readonly #maxAgeMs: number;
  readonly #maxUncertaintyMs: number;
  readonly #driftPpm: number;
  #lastMonotonicMs: number;
  #invalidated = false;

  constructor(input: {
    sample: TrustedTimeSample;
    maxAgeMs: number;
    maxUncertaintyMs: number;
    driftPpm: number;
  }) {
    const { sample, maxAgeMs, maxUncertaintyMs, driftPpm } = input;
    if (
      ![
        sample.earliestUnixMs,
        sample.latestUnixMs,
        sample.observedMonotonicMs,
        maxAgeMs,
        maxUncertaintyMs,
        driftPpm,
      ].every(Number.isSafeInteger) ||
      sample.earliestUnixMs < 0 ||
      sample.latestUnixMs < sample.earliestUnixMs ||
      sample.observedMonotonicMs < 0 ||
      !sample.bootId.trim() ||
      maxAgeMs <= 0 ||
      maxUncertaintyMs < 0 ||
      driftPpm < 0 ||
      driftPpm > 1_000_000 ||
      sample.latestUnixMs - sample.earliestUnixMs > maxUncertaintyMs
    )
      throw new UntrustedTerminalTime("Invalid trusted time policy or sample");
    this.#sample = { ...sample };
    this.#lastMonotonicMs = sample.observedMonotonicMs;
    this.#maxAgeMs = maxAgeMs;
    this.#maxUncertaintyMs = maxUncertaintyMs;
    this.#driftPpm = driftPpm;
  }

  window(monotonicMs: number, bootId: string) {
    if (
      this.#invalidated ||
      !Number.isSafeInteger(monotonicMs) ||
      bootId !== this.#sample.bootId ||
      monotonicMs < this.#lastMonotonicMs
    ) {
      this.#invalidated = true;
      throw new UntrustedTerminalTime("Device clock continuity lost; refresh trusted time");
    }
    this.#lastMonotonicMs = monotonicMs;
    const elapsed = monotonicMs - this.#sample.observedMonotonicMs;
    if (elapsed >= this.#maxAgeMs) throw new UntrustedTerminalTime("Trusted time sample expired");
    const drift = Number((BigInt(elapsed) * BigInt(this.#driftPpm) + 999_999n) / 1_000_000n);
    const earliestUnixMs = this.#sample.earliestUnixMs + elapsed - drift;
    const latestUnixMs = this.#sample.latestUnixMs + elapsed + drift;
    if (
      !Number.isSafeInteger(earliestUnixMs) ||
      !Number.isSafeInteger(latestUnixMs) ||
      latestUnixMs - earliestUnixMs > this.#maxUncertaintyMs
    )
      throw new UntrustedTerminalTime("Trusted time uncertainty exceeds policy");
    return { earliestUnixMs, latestUnixMs };
  }

  /** Both ends must fit: a best-guess wall clock cannot authorize a boundary sale. */
  authorizeSale(input: {
    monotonicMs: number;
    bootId: string;
    acceptFrom: number;
    acceptUntil: number;
    expiresAt: number;
  }): number {
    if (
      ![input.acceptFrom, input.acceptUntil, input.expiresAt].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value < 2 ** 48,
      ) ||
      input.acceptFrom >= input.acceptUntil ||
      input.expiresAt > input.acceptUntil
    )
      throw new UntrustedTerminalTime("Invalid sale time window");
    const time = this.window(input.monotonicMs, input.bootId);
    if (
      BigInt(time.earliestUnixMs) < BigInt(input.acceptFrom) * 1000n ||
      BigInt(time.latestUnixMs) >= BigInt(input.acceptUntil) * 1000n ||
      BigInt(time.latestUnixMs) >= BigInt(input.expiresAt) * 1000n
    )
      throw new UntrustedTerminalTime("Sale falls outside the trusted acceptance window");
    return Math.floor(time.earliestUnixMs / 1000);
  }
}
