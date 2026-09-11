import { decodeAbiParameters, keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  encodePaymentIntent,
  eventFactoryAbi,
  type PaymentIntent,
  paymentIntentDigest,
  paymentIntentFields,
  paymentIntentStructHash,
} from "../src/payments.js";

const intent: PaymentIntent = {
  schemaVersion: 1,
  chainId: 10143n,
  router: "0x0000000000000000000000000000000000000101",
  eventId: keccak256(stringToHex("event:market-2026")),
  paymentId: keccak256(stringToHex("payment:1")),
  payerAccount: "0x0000000000000000000000000000000000000202",
  orderRefHash: keccak256(stringToHex("order:42:v1")),
  vendorId: keccak256(stringToHex("vendor:noodles")),
  vendorDestinationVersion: 1n,
  terminalInstanceId: keccak256(stringToHex("terminal:noodles:1")),
  asset: "0x0000000000000000000000000000000000000303",
  grossUnits: 12_345_000n,
  organizerFeeBps: 200,
  platformFeeBps: 100,
  configVersion: 1n,
  receiptCommitment: keccak256(stringToHex("salted-private-receipt")),
  validAfter: 1_800_000_000,
  expiresAt: 1_800_000_300,
  terminalKeyVersion: 1n,
};

describe("payment intent", () => {
  it("binds every economic and authority field", () => {
    const digest = paymentIntentDigest(intent);
    for (const mutation of [
      { router: intent.payerAccount },
      { paymentId: intent.orderRefHash },
      { payerAccount: intent.router },
      { vendorId: intent.eventId },
      { grossUnits: intent.grossUnits + 1n },
      { organizerFeeBps: 201 },
      { receiptCommitment: intent.paymentId },
      { expiresAt: intent.expiresAt + 1 },
      { terminalKeyVersion: 2n },
    ]) {
      expect(paymentIntentDigest({ ...intent, ...mutation })).not.toBe(digest);
    }
  });

  it("encodes the exact Solidity tuple without decimal conversion", () => {
    const [decoded] = decodeAbiParameters(
      [{ type: "tuple", components: paymentIntentFields }],
      encodePaymentIntent(intent),
    );
    expect(decoded).toEqual(intent);
  });

  it("has a stable canonical struct hash", () => {
    expect(paymentIntentStructHash(intent)).toBe(
      "0x43dafb74a49c5b8df4499917fd6b9b96af7ce26e59c53bd4eb1d0e8bad56928c",
    );
  });
});

describe("event factory ABI", () => {
  it("exposes atomic deployment and read-back", () => {
    expect(
      eventFactoryAbi.some((item) => item.type === "function" && item.name === "deployEvent"),
    ).toBe(true);
    expect(
      eventFactoryAbi.some((item) => item.type === "function" && item.name === "getDeployment"),
    ).toBe(true);
    expect(
      eventFactoryAbi.some((item) => item.type === "event" && item.name === "EventDeployed"),
    ).toBe(true);
  });
});
