import { decodeAbiParameters, keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodePaymentIntent,
  decodeRefundIntent,
  encodeOfflineVoucher,
  encodePaymentIntent,
  encodeRefundIntent,
  eventFactoryAbi,
  type OfflineVoucher,
  offlineVoucherDigest,
  offlineVoucherFields,
  offlineVoucherStructHash,
  type PaymentIntent,
  paymentIntentDigest,
  paymentIntentFields,
  paymentIntentStructHash,
  type RefundIntent,
  type ReserveChannelConfig,
  refundIntentDigest,
  refundIntentFields,
  refundIntentStructHash,
  reserveChannelFields,
  reserveChannelTermsHash,
  validateOfflineVoucher,
  validatePaymentIntent,
  validateRefundIntent,
  validateReserveChannelConfig,
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

const refundIntent: RefundIntent = {
  schemaVersion: 1,
  chainId: 10143n,
  router: intent.router,
  eventId: intent.eventId,
  refundId: keccak256(stringToHex("refund:1")),
  paymentId: intent.paymentId,
  payerAccount: intent.payerAccount,
  vendorId: intent.vendorId,
  asset: intent.asset,
  refundUnits: 5_000_000n,
  cumulativeRefundUnits: 5_000_000n,
  vendorCreditUnits: 4_850_000n,
  fundingSource: "0x0000000000000000000000000000000000000404",
  validAfter: 1_800_000_100,
  expiresAt: 1_800_003_600,
};

const reserveConfig: ReserveChannelConfig = {
  channelId: keccak256(stringToHex("channel:1")),
  eventId: intent.eventId,
  asset: intent.asset,
  reserveUnits: 20_000_000n,
  vendorId: intent.vendorId,
  vendorDestinationVersion: 1n,
  terminalInstanceId: intent.terminalInstanceId,
  terminalKeyVersion: 1n,
  attendeeChannelSigner: "0x0000000000000000000000000000000000000505",
  configVersion: 1n,
  organizerFeeBps: 200,
  platformFeeBps: 100,
  maxPerVoucher: 5_000_000n,
  maxVoucherCount: 4,
  acceptFrom: 1_800_000_000,
  acceptUntil: 1_800_000_120,
  submitUntil: 1_800_000_180,
  genesisDigest: keccak256(stringToHex("channel:1:genesis")),
};

const offlineVoucher: OfflineVoucher = {
  protocolVersion: 1,
  chainId: intent.chainId,
  vault: "0x0000000000000000000000000000000000000606",
  channelId: reserveConfig.channelId,
  sequence: 1,
  previousVoucherDigest: reserveConfig.genesisDigest,
  paymentId: keccak256(stringToHex("offline-payment:1")),
  orderRefHash: keccak256(stringToHex("offline-order:1")),
  grossUnits: 4_000_000n,
  cumulativeGrossUnits: 4_000_000n,
  receiptCommitment: keccak256(stringToHex("offline-receipt:1")),
  acceptedAt: 1_800_000_060,
  acceptUntil: reserveConfig.acceptUntil,
  submitUntil: reserveConfig.submitUntil,
  configVersion: 1n,
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
    expect(decodePaymentIntent(encodePaymentIntent(intent))).toEqual(intent);
  });

  it("has a stable canonical struct hash", () => {
    expect(paymentIntentStructHash(intent)).toBe(
      "0x43dafb74a49c5b8df4499917fd6b9b96af7ce26e59c53bd4eb1d0e8bad56928c",
    );
  });

  it("rejects malformed economic and authority boundaries before encoding", () => {
    expect(() => validatePaymentIntent({ ...intent, grossUnits: 0n })).toThrow(
      "Invalid payment intent",
    );
    expect(() =>
      encodePaymentIntent({ ...intent, organizerFeeBps: 9_999, platformFeeBps: 2 }),
    ).toThrow("Invalid payment intent");
  });
});

describe("refund intent", () => {
  it("binds payer, payment, funding, amount, and cumulative ordering", () => {
    const digest = refundIntentDigest(refundIntent);
    for (const mutation of [
      { refundId: intent.paymentId },
      { paymentId: refundIntent.refundId },
      { payerAccount: refundIntent.fundingSource },
      {
        refundUnits: refundIntent.refundUnits + 1n,
        cumulativeRefundUnits: refundIntent.cumulativeRefundUnits + 1n,
      },
      { cumulativeRefundUnits: refundIntent.cumulativeRefundUnits + 1n },
      { vendorCreditUnits: refundIntent.vendorCreditUnits + 1n },
      { fundingSource: refundIntent.payerAccount },
      { expiresAt: refundIntent.expiresAt + 1 },
    ]) {
      expect(refundIntentDigest({ ...refundIntent, ...mutation })).not.toBe(digest);
    }
  });

  it("encodes the canonical Solidity tuple", () => {
    const [decoded] = decodeAbiParameters(
      [{ type: "tuple", components: refundIntentFields }],
      encodeRefundIntent(refundIntent),
    );
    expect(decoded).toEqual(refundIntent);
    expect(decodeRefundIntent(encodeRefundIntent(refundIntent))).toEqual(refundIntent);
  });

  it("has a stable canonical struct hash", () => {
    expect(refundIntentStructHash(refundIntent)).toBe(
      "0x22dbd5a9e0c5faa0c0357665dbdb86f4e03daecf5499a16ed554f4c95cd1cc88",
    );
  });

  it("rejects unfunded ordering and invalid refund scope before encoding", () => {
    expect(() =>
      validateRefundIntent({ ...refundIntent, vendorCreditUnits: refundIntent.refundUnits + 1n }),
    ).toThrow("Invalid refund intent");
    expect(() =>
      encodeRefundIntent({ ...refundIntent, fundingSource: intent.router }),
    ).not.toThrow();
    expect(() =>
      encodeRefundIntent({
        ...refundIntent,
        fundingSource: "0x0000000000000000000000000000000000000000",
      }),
    ).toThrow("Invalid refund intent");
  });
});

describe("reserve channel and offline voucher", () => {
  it("binds every immutable channel term", () => {
    expect(
      reserveChannelTermsHash({
        chainId: intent.chainId,
        vault: offlineVoucher.vault,
        originalAccount: intent.payerAccount,
        config: reserveConfig,
      }),
    ).toBe("0x7d36cf640b5cdb33594c920e1287c8e000ea63de1676f4d3db8f7bed54393d36");
    expect(reserveChannelFields).toHaveLength(18);
  });

  it("encodes and hashes the canonical chained voucher", () => {
    const [decoded] = decodeAbiParameters(
      [{ type: "tuple", components: offlineVoucherFields }],
      encodeOfflineVoucher(offlineVoucher),
    );
    expect(decoded).toEqual(offlineVoucher);
    expect(offlineVoucherStructHash(offlineVoucher)).toBe(
      "0xf0fd7d5862fecf801ddacf176bf024e7f2e9958cf34ea4bc8d83abd9a2faf7e1",
    );
  });

  it("rejects values outside Solidity integer ranges", () => {
    expect(() => validateReserveChannelConfig({ ...reserveConfig, acceptFrom: 2 ** 48 })).toThrow(
      "Invalid acceptFrom",
    );
    expect(() => validateOfflineVoucher({ ...offlineVoucher, acceptedAt: 2 ** 48 })).toThrow(
      "Invalid acceptedAt",
    );
    expect(() => validateOfflineVoucher({ ...offlineVoucher, sequence: 2 ** 32 })).toThrow(
      "Invalid sequence",
    );
    expect(() =>
      validateReserveChannelConfig({
        ...reserveConfig,
        terminalInstanceId: `0x${"00".repeat(32)}`,
      }),
    ).toThrow("Invalid reserve channel policy");
    expect(() => validateOfflineVoucher({ ...offlineVoucher, protocolVersion: 2 })).toThrow(
      "Invalid offline voucher",
    );
    expect(() =>
      validateOfflineVoucher({ ...offlineVoucher, acceptedAt: offlineVoucher.acceptUntil }),
    ).toThrow("Invalid offline voucher");
  });

  it("binds sequence, previous digest, amount, and deadlines", () => {
    const digest = offlineVoucherDigest(offlineVoucher);
    for (const mutation of [
      { sequence: 2 },
      { previousVoucherDigest: offlineVoucher.paymentId },
      {
        grossUnits: offlineVoucher.grossUnits + 1n,
        cumulativeGrossUnits: offlineVoucher.cumulativeGrossUnits + 1n,
      },
      { cumulativeGrossUnits: offlineVoucher.cumulativeGrossUnits + 1n },
      { acceptedAt: offlineVoucher.acceptedAt + 1 },
      { submitUntil: offlineVoucher.submitUntil + 1 },
    ]) {
      expect(offlineVoucherDigest({ ...offlineVoucher, ...mutation })).not.toBe(digest);
    }
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
