import { expect, it } from "vitest";
import {
  canonicalVoucherReceipt,
  terminalIngressDigest,
  type VoucherReceipt,
  validateVoucherReceipt,
  voucherReceiptPayloadHash,
} from "../src/index.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;

const receipt: VoucherReceipt = {
  receiptId: "receipt:terminal:1",
  terminalId: hex32("1"),
  channelId: hex32("2"),
  sequence: 1,
  paymentId: hex32("3"),
  voucher: "0x1234",
  attendeeSignature: `0x${"aa".repeat(65)}`,
  terminalSignature: `0x${"bb".repeat(65)}`,
};

it("canonicalizes receipt transport without numeric or case ambiguity", () => {
  const upper = {
    ...receipt,
    terminalId: `0x${receipt.terminalId.slice(2).toUpperCase()}` as `0x${string}`,
  };
  expect(canonicalVoucherReceipt(upper)).toBe(canonicalVoucherReceipt(receipt));
  expect(voucherReceiptPayloadHash(upper)).toBe(voucherReceiptPayloadHash(receipt));
  expect(voucherReceiptPayloadHash(receipt)).toMatch(/^[0-9a-f]{64}$/);
  expect(() => validateVoucherReceipt({ ...receipt, attendeeSignature: "0x12" })).toThrow(
    "Invalid voucher receipt",
  );
});

it("binds ingress authorization to its audience, key version, nonce, and payload", () => {
  const base = {
    audience: "https://relay.example/v1/vouchers",
    terminalId: receipt.terminalId,
    keyVersion: 1n,
    sentAt: 100,
    nonce: hex32("4"),
    payloadHash: `0x${voucherReceiptPayloadHash(receipt)}` as `0x${string}`,
  };
  const digest = terminalIngressDigest(base);
  expect(terminalIngressDigest(base)).toBe(digest);
  expect(
    terminalIngressDigest({ ...base, audience: "https://other.example/v1/vouchers" }),
  ).not.toBe(digest);
  expect(terminalIngressDigest({ ...base, nonce: hex32("5") })).not.toBe(digest);
});
