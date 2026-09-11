import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidTransition,
  ReceiptConflict,
  receiptPayloadHash,
  VenueRelayJournal,
  type VoucherReceipt,
} from "../src/journal.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const bytes = (byte: string) => `0x${byte.repeat(130)}` as `0x${string}`;

function receipt(sequence: number, suffix: string): VoucherReceipt {
  return {
    receiptId: `receipt:${suffix}`,
    terminalId: hex32("1"),
    channelId: hex32("2"),
    sequence,
    paymentId: hex32(suffix),
    voucher: bytes("3"),
    attendeeSignature: `0x${"4".repeat(130)}`,
    terminalSignature: `0x${"5".repeat(130)}`,
  };
}

describe("venue relay journal", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { force: true, recursive: true });
  });

  function journal(): { instance: VenueRelayJournal; path: string; key: Buffer } {
    const directory = mkdtempSync(join(tmpdir(), "openbalance-relay-"));
    directories.push(directory);
    const path = join(directory, "relay.sqlite");
    const key = randomBytes(32);
    return { instance: new VenueRelayJournal(path, key), path, key };
  }

  it("persists encrypted receipts across restart", () => {
    const { instance, path, key } = journal();
    const value = receipt(1, "a");
    expect(instance.ingest(value, 100).created).toBe(true);
    expect(instance.ingest(value, 101).created).toBe(false);
    instance.close();
    expect(readFileSync(path).includes(Buffer.from(value.attendeeSignature))).toBe(false);

    const wrongKeyJournal = new VenueRelayJournal(path, randomBytes(32));
    expect(() => wrongKeyJournal.get(value.receiptId)).toThrow();
    wrongKeyJournal.close();
    const reopened = new VenueRelayJournal(path, key);
    expect(reopened.get(value.receiptId).receipt).toEqual(value);
    reopened.close();
  });

  it("rejects conflicting receipt, sequence, and payment identities", () => {
    const { instance } = journal();
    instance.ingest(receipt(1, "a"), 100);
    expect(() => instance.ingest({ ...receipt(1, "a"), voucher: bytes("6") }, 101)).toThrow(
      ReceiptConflict,
    );
    expect(() => instance.ingest(receipt(1, "b"), 101)).toThrow(ReceiptConflict);
    expect(() => instance.ingest({ ...receipt(2, "c"), paymentId: hex32("a") }, 101)).toThrow(
      ReceiptConflict,
    );
    instance.close();
  });

  it("persists terminal authentication nonce with the receipt atomically", () => {
    const { instance } = journal();
    const value = receipt(1, "a");
    const ingress = {
      nonce: hex32("9"),
      payloadHash: receiptPayloadHash(value),
      authenticatedAt: 100,
    };
    expect(instance.ingestAuthenticated(value, ingress, 100).created).toBe(true);
    expect(instance.ingestAuthenticated(value, ingress, 101).created).toBe(false);
    const changed = { ...value, receiptId: "receipt:changed" };
    expect(() =>
      instance.ingestAuthenticated(
        changed,
        { ...ingress, payloadHash: receiptPayloadHash(changed) },
        102,
      ),
    ).toThrow(ReceiptConflict);
    instance.close();
  });

  it("leases only the earliest unresolved receipt per channel", () => {
    const { instance } = journal();
    instance.ingest(receipt(2, "b"), 101);
    instance.ingest(receipt(1, "a"), 100);
    const first = instance.leaseReady(10, "worker:1", 200, 10_000);
    expect(first.map((item) => item.sequence)).toEqual([1]);
    expect(instance.leaseReady(10, "worker:2", 200, 10_000)).toEqual([]);
    instance.markSubmitted(first[0]?.receiptId ?? "", "worker:1", hex32("d"), 201);
    instance.markSettled("receipt:a", hex32("d"), 202);
    expect(instance.leaseReady(10, "worker:2", 203, 10_000)[0]?.sequence).toBe(2);
    instance.close();
  });

  it("enforces lease ownership and durable retry timing", () => {
    const { instance } = journal();
    instance.ingest(receipt(1, "a"), 100);
    instance.leaseReady(1, "worker:1", 200, 1_000);
    expect(() => instance.retry("receipt:a", "worker:2", 500, "rpc timeout", 201)).toThrow(
      InvalidTransition,
    );
    instance.retry("receipt:a", "worker:1", 500, "rpc timeout", 201);
    expect(instance.leaseReady(1, "worker:2", 499, 1_000)).toEqual([]);
    expect(instance.leaseReady(1, "worker:2", 500, 1_000)[0]?.attempts).toBe(2);
    instance.close();
  });

  it("releases submitted receipts for reconciliation after restart", () => {
    const { instance, path, key } = journal();
    instance.ingest(receipt(1, "a"), 100);
    instance.leaseReady(1, "worker:1", 200, 1_000);
    instance.markSubmitted("receipt:a", "worker:1", hex32("d"), 201);
    instance.close();

    const reopened = new VenueRelayJournal(path, key);
    const submitted = reopened.leaseReady(1, "worker:2", 202, 1_000);
    expect(submitted[0]?.state).toBe("SUBMITTED");
    reopened.deferSubmitted("receipt:a", "worker:2", 500, 203);
    expect(reopened.leaseReady(1, "worker:3", 499, 1_000)).toEqual([]);
    expect(reopened.leaseReady(1, "worker:3", 500, 1_000)[0]?.transactionHash).toBe(hex32("d"));
    reopened.close();
  });

  it("quarantine blocks later channel receipts without deleting evidence", () => {
    const { instance } = journal();
    instance.ingest(receipt(1, "a"), 100);
    instance.ingest(receipt(2, "b"), 101);
    instance.leaseReady(1, "worker:1", 200, 1_000);
    instance.quarantine("receipt:a", "worker:1", "conflicting voucher", 201);
    expect(instance.get("receipt:a").state).toBe("QUARANTINED");
    expect(instance.leaseReady(10, "worker:2", 1_500, 1_000)).toEqual([]);
    instance.close();
  });
});
