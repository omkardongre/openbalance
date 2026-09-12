import { expect, it } from "vitest";
import { TerminalClock } from "../src/clock.js";
import { config, createJournal, hex32 } from "./fixtures.js";

const create = () =>
  new TerminalClock({
    sample: {
      earliestUnixMs: 100_000,
      latestUnixMs: 100_100,
      observedMonotonicMs: 1000,
      bootId: "boot:1",
    },
    maxAgeMs: 10_000,
    maxUncertaintyMs: 200,
    driftPpm: 1000,
  });

it("advances a bounded time interval and rejects uncertain deadline crossings", () => {
  const clock = create();
  expect(clock.window(2000, "boot:1")).toEqual({ earliestUnixMs: 100_999, latestUnixMs: 101_101 });
  expect(
    clock.authorizeSale({
      monotonicMs: 2000,
      bootId: "boot:1",
      acceptFrom: 100,
      acceptUntil: 110,
      expiresAt: 105,
    }),
  ).toBe(100);
  expect(() =>
    clock.authorizeSale({
      monotonicMs: 5900,
      bootId: "boot:1",
      acceptFrom: 100,
      acceptUntil: 105,
      expiresAt: 105,
    }),
  ).toThrow("outside");
});

it("fails closed for restart, monotonic rollback, stale samples and excess drift", () => {
  expect(() => create().window(2000, "boot:2")).toThrow("continuity");
  const clock = create();
  clock.window(2000, "boot:1");
  expect(() => clock.window(1999, "boot:1")).toThrow("continuity");
  expect(() => clock.window(3000, "boot:1")).toThrow("continuity");
  expect(() => create().window(11_000, "boot:1")).toThrow("expired");
  const drifting = new TerminalClock({
    sample: {
      earliestUnixMs: 100_000,
      latestUnixMs: 100_000,
      observedMonotonicMs: 0,
      bootId: "boot:1",
    },
    maxAgeMs: 10_000,
    maxUncertaintyMs: 10,
    driftPpm: 1000,
  });
  expect(() => drifting.window(6000, "boot:1")).toThrow("uncertainty");
});

it("uses registered channel deadlines before preparing a durable sale", () => {
  const { journal } = createJournal();
  const input = {
    requestId: "clock:sale",
    channelId: config.channelId,
    paymentId: hex32("c"),
    orderRefHash: hex32("a"),
    grossUnits: 100n,
    receiptCommitment: hex32("b"),
    expiresAt: 105,
  };
  try {
    expect(() =>
      journal.prepareTimedSale(input, create(), { monotonicMs: 5900, bootId: "boot:1" }),
    ).toThrow("outside");
    const sale = journal.prepareTimedSale(input, create(), { monotonicMs: 2000, bootId: "boot:1" });
    expect(sale.request.sequence).toBe(1);
    expect(sale.state).toBe("PREPARED");
  } finally {
    journal.close();
  }
});
