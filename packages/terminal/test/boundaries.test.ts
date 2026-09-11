import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { TerminalJournal } from "../src/journal.js";
import { decodePaymentRequestQr, InvalidQrExchange } from "../src/qr.js";
import { RelayUploadClient } from "../src/upload.js";

it("requires an exact 256-bit journal encryption key", () => {
  expect(() => new TerminalJournal(":memory:", randomBytes(31))).toThrow(
    "Terminal journal key must be 32 bytes",
  );
});

it("requires a pinned HTTPS relay audience", () => {
  const journal = new TerminalJournal(":memory:", randomBytes(32));
  try {
    const common = {
      journal,
      keyVersion: 1n,
      owner: "uploader:terminal",
      signer: { sign: async () => `0x${"11".repeat(65)}` as `0x${string}` },
    };
    expect(
      () =>
        new RelayUploadClient({
          ...common,
          endpoint: "http://relay.example/receipts",
          audience: "http://relay.example/receipts",
        }),
    ).toThrow("Invalid relay upload configuration");
    expect(
      () =>
        new RelayUploadClient({
          ...common,
          endpoint: "https://relay.example/receipts",
          audience: "https://other.example/receipts",
        }),
    ).toThrow("Invalid relay upload configuration");
  } finally {
    journal.close();
  }
});

it("rejects oversized and unversioned QR envelopes", () => {
  expect(() => decodePaymentRequestQr(`obqr1:${"a".repeat(4_091)}`)).toThrow(InvalidQrExchange);
  expect(() => decodePaymentRequestQr("obqr2:e30")).toThrow(InvalidQrExchange);
});
