import { decodeOfflineVoucher, offlineVoucherDigest } from "@openbalance/protocol";
import { expect, it } from "vitest";
import {
  decodeAttendeeResponseQr,
  decodePaymentRequestQr,
  encodeAttendeeResponseQr,
  encodePaymentRequestQr,
  InvalidQrExchange,
  paymentRequestHash,
  verifyAttendeeResponse,
} from "../src/qr.js";
import { attendee, config, createJournal, hex32 } from "./fixtures.js";

it("round-trips canonical request and response payloads", async () => {
  const fixture = createJournal();
  try {
    const sale = fixture.journal.prepareSale({
      requestId: "request:qr",
      channelId: config.channelId,
      paymentId: hex32("c"),
      orderRefHash: hex32("d"),
      grossUnits: 125n,
      receiptCommitment: hex32("e"),
      acceptedAt: 100,
      expiresAt: 150,
    });
    const request = decodePaymentRequestQr(encodePaymentRequestQr(sale.request));
    const attendeeSignature = await attendee.sign({
      hash: offlineVoucherDigest(decodeOfflineVoucher(request.voucher)),
    });
    const response = decodeAttendeeResponseQr(
      encodeAttendeeResponseQr({
        version: 1,
        kind: "offline-voucher-response",
        requestHash: paymentRequestHash(request),
        attendeeSignature,
      }),
    );
    await expect(
      verifyAttendeeResponse({
        request,
        response,
        attendeeSigner: attendee.address,
        nowSeconds: 110,
      }),
    ).resolves.toBe(attendeeSignature);
  } finally {
    fixture.journal.close();
  }
});

it("rejects expired, cross-request, and noncanonical responses", async () => {
  const fixture = createJournal();
  try {
    const sale = fixture.journal.prepareSale({
      requestId: "request:reject",
      channelId: config.channelId,
      paymentId: hex32("d"),
      orderRefHash: hex32("e"),
      grossUnits: 100n,
      receiptCommitment: hex32("f"),
      acceptedAt: 100,
      expiresAt: 150,
    });
    const attendeeSignature = await attendee.sign({
      hash: offlineVoucherDigest(decodeOfflineVoucher(sale.request.voucher)),
    });
    const response = {
      version: 1 as const,
      kind: "offline-voucher-response" as const,
      requestHash: paymentRequestHash(sale.request),
      attendeeSignature,
    };
    await expect(
      verifyAttendeeResponse({
        request: sale.request,
        response,
        attendeeSigner: attendee.address,
        nowSeconds: 151,
      }),
    ).rejects.toThrow(InvalidQrExchange);
    await expect(
      verifyAttendeeResponse({
        request: sale.request,
        response: { ...response, requestHash: hex32("0") },
        attendeeSigner: attendee.address,
        nowSeconds: 110,
      }),
    ).rejects.toThrow(InvalidQrExchange);

    const canonical = JSON.stringify(response);
    const withExtraField = `obqr1:${Buffer.from(`${canonical.slice(0, -1)},"extra":true}`).toString("base64url")}`;
    expect(() => decodeAttendeeResponseQr(withExtraField)).toThrow(InvalidQrExchange);
    expect(() =>
      decodePaymentRequestQr(`obqr1:${Buffer.from("null").toString("base64url")}`),
    ).toThrow(InvalidQrExchange);
  } finally {
    fixture.journal.close();
  }
});
