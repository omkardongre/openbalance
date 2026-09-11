import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
} from "@openbalance/protocol";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, expect, it } from "vitest";
import { buildVenueRelayApp } from "../src/app.js";
import { receiptPayloadHash, VenueRelayJournal, type VoucherReceipt } from "../src/journal.js";
import { terminalIngressDigest } from "../src/transport.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const terminal = privateKeyToAccount(hex32("1"));
const audience = "https://relay.example/v1/vouchers";
const directories: string[] = [];
const apps: Awaited<ReturnType<typeof buildVenueRelayApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function payload() {
  const voucher: OfflineVoucher = {
    protocolVersion: 1,
    chainId: 10_143n,
    vault: "0x2222222222222222222222222222222222222222",
    channelId: hex32("3"),
    sequence: 1,
    previousVoucherDigest: hex32("4"),
    paymentId: hex32("5"),
    orderRefHash: hex32("6"),
    grossUnits: 100n,
    cumulativeGrossUnits: 100n,
    receiptCommitment: hex32("7"),
    acceptedAt: 100,
    acceptUntil: 200,
    submitUntil: 300,
    configVersion: 1n,
  };
  const receipt: VoucherReceipt = {
    receiptId: "receipt:terminal:1",
    terminalId: hex32("8"),
    channelId: voucher.channelId,
    sequence: voucher.sequence,
    paymentId: voucher.paymentId,
    voucher: encodeOfflineVoucher(voucher),
    attendeeSignature: `0x${"aa".repeat(65)}`,
    terminalSignature: await terminal.sign({ hash: offlineVoucherDigest(voucher) }),
  };
  const sentAt = 110;
  const nonce = hex32("9");
  return {
    receipt,
    authorization: {
      keyVersion: "1",
      sentAt,
      nonce,
      signature: await terminal.sign({
        hash: terminalIngressDigest({
          audience,
          terminalId: receipt.terminalId as `0x${string}`,
          keyVersion: 1n,
          sentAt,
          nonce,
          payloadHash: `0x${receiptPayloadHash(receipt)}`,
        }),
      }),
    },
  };
}

it("accepts an authenticated receipt idempotently and rejects nonce conflicts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbalance-relay-app-"));
  directories.push(directory);
  const journal = new VenueRelayJournal(join(directory, "relay.sqlite"), randomBytes(32));
  const app = await buildVenueRelayApp({
    journal,
    audience,
    now: () => 111_000,
    directory: {
      resolve: async () => ({
        signer: terminal.address,
        enabled: true,
        validAfter: 50,
        validUntil: 250,
      }),
    },
  });
  apps.push(app);
  app.addHook("onClose", async () => journal.close());
  const input = await payload();
  const created = await app.inject({ method: "POST", url: "/v1/vouchers", payload: input });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ duplicate: false, state: "PENDING" });
  const duplicate = await app.inject({ method: "POST", url: "/v1/vouchers", payload: input });
  expect(duplicate.statusCode).toBe(200);
  expect(duplicate.json()).toMatchObject({ duplicate: true, state: "PENDING" });

  const conflicting = await app.inject({
    method: "POST",
    url: "/v1/vouchers",
    payload: { ...input, receipt: { ...input.receipt, receiptId: "receipt:other" } },
  });
  expect(conflicting.statusCode).toBe(401);
});
