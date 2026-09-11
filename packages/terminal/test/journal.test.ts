import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeOfflineVoucher, offlineVoucherDigest } from "@openbalance/protocol";
import { expect, it } from "vitest";
import { TerminalJournal, TerminalJournalConflict } from "../src/journal.js";
import { acceptSale, attendee, config, createJournal, hex32, terminal } from "./fixtures.js";

it("recovers an attendee-signed sale after restart and advances the channel atomically", async () => {
  const fixture = createJournal();
  try {
    const prepared = fixture.journal.prepareSale({
      requestId: "request:restart",
      channelId: config.channelId,
      paymentId: hex32("c"),
      orderRefHash: hex32("d"),
      grossUnits: 120n,
      receiptCommitment: hex32("e"),
      acceptedAt: 100,
      expiresAt: 150,
    });
    const voucher = decodeOfflineVoucher(prepared.request.voucher);
    const attendeeSignature = await attendee.sign({ hash: offlineVoucherDigest(voucher) });
    await fixture.journal.recordAttendeeResponse(
      prepared.requestId,
      {
        version: 1,
        kind: "offline-voucher-response",
        requestHash: (await import("../src/qr.js")).paymentRequestHash(prepared.request),
        attendeeSignature,
      },
      110,
      110_000,
    );
    fixture.journal.close();

    const reopened = new TerminalJournal(fixture.path, fixture.key);
    const terminalSignature = await terminal.sign({ hash: offlineVoucherDigest(voucher) });
    const accepted = await reopened.acceptSale(
      prepared.requestId,
      "receipt:restart",
      terminalSignature,
      111_000,
    );
    expect(accepted.state).toBe("ACCEPTED");
    expect(accepted.receipt?.attendeeSignature).toBe(attendeeSignature);

    const next = reopened.prepareSale({
      requestId: "request:next",
      channelId: config.channelId,
      paymentId: hex32("f"),
      orderRefHash: hex32("a"),
      grossUnits: 80n,
      receiptCommitment: hex32("b"),
      acceptedAt: 120,
      expiresAt: 160,
    });
    const nextVoucher = decodeOfflineVoucher(next.request.voucher);
    expect(nextVoucher.sequence).toBe(2);
    expect(nextVoucher.cumulativeGrossUnits).toBe(200n);
    expect(nextVoucher.previousVoucherDigest).toBe(offlineVoucherDigest(voucher));
    reopened.close();

    expect(
      readFileSync(fixture.path).includes(Buffer.from(attendeeSignature.slice(2), "hex")),
    ).toBe(false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("rejects duplicate channel sequence and preserves upload ordering", async () => {
  const fixture = createJournal();
  try {
    const first = await acceptSale(fixture.journal, "c", 100n);
    await expect(acceptSale(fixture.journal, "d", 100n)).resolves.toMatchObject({
      state: "ACCEPTED",
    });
    expect(() =>
      fixture.journal.prepareSale({
        requestId: "request:conflict",
        channelId: config.channelId,
        paymentId: hex32("e"),
        orderRefHash: hex32("a"),
        grossUnits: 50n,
        receiptCommitment: hex32("b"),
        acceptedAt: 120,
        expiresAt: 150,
      }),
    ).not.toThrow();
    const [leased] = fixture.journal.leaseUploads(10, "uploader", 120_000, 30_000);
    expect(leased?.requestId).toBe(first.requestId);
    expect(fixture.journal.leaseUploads(10, "other", 120_000, 30_000)).toEqual([]);
    expect(() =>
      fixture.journal.registerChannel({
        chainId: 10_143n,
        vault: "0x9999999999999999999999999999999999999999",
        terminalSigner: terminal.address,
        config: { ...config, maxPerVoucher: 499n },
      }),
    ).toThrow(TerminalJournalConflict);
  } finally {
    fixture.journal.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("fails closed when the persisted channel snapshot changes", () => {
  const fixture = createJournal();
  fixture.journal.close();
  const database = new DatabaseSync(fixture.path);
  database.prepare("UPDATE terminal_channels SET snapshot=replace(snapshot,'10143','10144')").run();
  database.close();
  const reopened = new TerminalJournal(fixture.path, fixture.key);
  try {
    expect(() =>
      reopened.prepareSale({
        requestId: "request:tampered",
        channelId: config.channelId,
        paymentId: hex32("e"),
        orderRefHash: hex32("a"),
        grossUnits: 50n,
        receiptCommitment: hex32("b"),
        acceptedAt: 100,
        expiresAt: 150,
      }),
    ).toThrow("Terminal channel snapshot integrity failure");
  } finally {
    reopened.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
