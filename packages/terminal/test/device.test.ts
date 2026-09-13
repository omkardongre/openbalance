import { decodeOfflineVoucher, offlineVoucherDigest } from "@openbalance/protocol";
import { expect, it } from "vitest";
import { TerminalDeviceController, TerminalDeviceNotReady } from "../src/device.js";
import { encodeAttendeeResponseQr, paymentRequestHash } from "../src/qr.js";
import { attendee, config, createJournal, hex32, terminal } from "./fixtures.js";

it("coordinates trusted time, QR response, protected signing, and durable acceptance", async () => {
  const fixture = createJournal();
  let scanned = "";
  let monotonicMs = 1_000;
  const controller = new TerminalDeviceController(
    fixture.journal,
    {
      signer: terminal.address,
      keyVersion: 1n,
      signDigest: (digest) => terminal.sign({ hash: digest }),
    },
    {
      async sample() {
        return {
          earliestUnixMs: 100_000,
          latestUnixMs: 100_100,
          observedMonotonicMs: 1_000,
          bootId: "boot:trusted",
        };
      },
    },
    { read: () => ({ monotonicMs, bootId: "boot:trusted" }) },
    { scan: async () => scanned },
    {
      maximumTimeSampleAgeMs: 60_000,
      maximumTimeUncertaintyMs: 500,
      maximumClockDriftPpm: 100,
    },
  );
  try {
    expect(() =>
      controller.preparePayment({
        requestId: "device:not-ready",
        channelId: config.channelId,
        paymentId: hex32("a"),
        orderRefHash: hex32("b"),
        grossUnits: 100n,
        receiptCommitment: hex32("c"),
        expiresAt: 150,
      }),
    ).toThrow(TerminalDeviceNotReady);
    await controller.refreshTrustedTime();
    const prepared = controller.preparePayment({
      requestId: "device:accepted",
      channelId: config.channelId,
      paymentId: hex32("d"),
      orderRefHash: hex32("e"),
      grossUnits: 100n,
      receiptCommitment: hex32("f"),
      expiresAt: 150,
    });
    const voucher = decodeOfflineVoucher(prepared.sale.request.voucher);
    scanned = encodeAttendeeResponseQr({
      version: 1,
      kind: "offline-voucher-response",
      requestHash: paymentRequestHash(prepared.sale.request),
      attendeeSignature: await attendee.sign({ hash: offlineVoucherDigest(voucher) }),
    });
    monotonicMs = 2_000;
    const accepted = await controller.scanAndAccept("device:accepted");
    expect(accepted.sale).toMatchObject({ state: "ACCEPTED" });
    expect(JSON.parse(accepted.receiptQrPayload)).toMatchObject({ paymentId: hex32("d") });
    await expect(controller.scanAndAccept("device:accepted")).resolves.toEqual(accepted);
  } finally {
    fixture.journal.close();
  }
});
