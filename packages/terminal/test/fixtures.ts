import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeOfflineVoucher,
  offlineVoucherDigest,
  type ReserveChannelConfig,
} from "@openbalance/protocol";
import { privateKeyToAccount } from "viem/accounts";
import { TerminalJournal } from "../src/journal.js";
import { paymentRequestHash } from "../src/qr.js";

export const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
export const attendee = privateKeyToAccount(hex32("1"));
export const terminal = privateKeyToAccount(hex32("2"));

export const config: ReserveChannelConfig = {
  channelId: hex32("3"),
  eventId: hex32("4"),
  asset: "0x5555555555555555555555555555555555555555",
  reserveUnits: 1_000n,
  vendorId: hex32("6"),
  vendorDestinationVersion: 1n,
  terminalInstanceId: hex32("7"),
  terminalKeyVersion: 1n,
  attendeeChannelSigner: attendee.address,
  configVersion: 1n,
  organizerFeeBps: 100,
  platformFeeBps: 50,
  maxPerVoucher: 500n,
  maxVoucherCount: 10,
  acceptFrom: 50,
  acceptUntil: 200,
  submitUntil: 300,
  genesisDigest: hex32("8"),
};

export function createJournal() {
  const directory = mkdtempSync(join(tmpdir(), "openbalance-terminal-"));
  const path = join(directory, "terminal.sqlite");
  const key = randomBytes(32);
  const journal = new TerminalJournal(path, key);
  journal.registerChannel({
    chainId: 10_143n,
    vault: "0x9999999999999999999999999999999999999999",
    terminalSigner: terminal.address,
    config,
  });
  return { directory, path, key, journal };
}

export async function acceptSale(journal: TerminalJournal, suffix = "a", grossUnits = 100n) {
  const requestId = `request:${suffix}`;
  const prepared = journal.prepareSale({
    requestId,
    channelId: config.channelId,
    paymentId: hex32(suffix),
    orderRefHash: hex32("a"),
    grossUnits,
    receiptCommitment: hex32("b"),
    acceptedAt: 100,
    expiresAt: 150,
  });
  const voucher = decodeOfflineVoucher(prepared.request.voucher);
  const attendeeSignature = await attendee.sign({ hash: offlineVoucherDigest(voucher) });
  await journal.recordAttendeeResponse(
    requestId,
    {
      version: 1,
      kind: "offline-voucher-response",
      requestHash: paymentRequestHash(prepared.request),
      attendeeSignature,
    },
    110,
    110_000,
  );
  const terminalSignature = await terminal.sign({ hash: offlineVoucherDigest(voucher) });
  return journal.acceptSale(requestId, `receipt:${suffix}`, terminalSignature, 111_000);
}
