import {
  encodeOfflineVoucher,
  type OfflineVoucher,
  resilienceVaultAbi,
} from "@openbalance/protocol";
import { decodeFunctionData, keccak256, stringToHex } from "viem";
import { expect, it, vi } from "vitest";
import type { AcceptFinancialOperation, FinancialOperation } from "../src/financial-operations.js";
import { VendorCommandRejected } from "../src/vendor-commands.js";
import {
  type FinalizedChannel,
  VendorVoucherSettlementService,
  VoucherChannelNotFound,
} from "../src/vendor-vouchers.js";

const eventId = keccak256(stringToHex("voucher-event"));
const vendorId = keccak256(stringToHex("voucher-vendor"));
const channelId = keccak256(stringToHex("voucher-channel"));
const vault = "0x0000000000000000000000000000000000000606";
const nowSeconds = 1_800_000_000n;
const signature = `0x${"11".repeat(65)}` as const;
const identity = {
  credentialId: "00000000-0000-4000-8000-000000000003",
  eventId,
  vendorId,
  authorityAddress: "0x0000000000000000000000000000000000000909",
} as const;
const voucher: OfflineVoucher = {
  protocolVersion: 1,
  chainId: 10_143n,
  vault,
  channelId,
  sequence: 1,
  previousVoucherDigest: keccak256(stringToHex("genesis")),
  paymentId: keccak256(stringToHex("voucher-payment")),
  orderRefHash: keccak256(stringToHex("order")),
  grossUnits: 1_000_000n,
  cumulativeGrossUnits: 1_000_000n,
  receiptCommitment: keccak256(stringToHex("receipt")),
  acceptedAt: Number(nowSeconds) - 60,
  acceptUntil: Number(nowSeconds) + 600,
  submitUntil: Number(nowSeconds) + 900,
  configVersion: 1n,
};

function build(channel: FinalizedChannel | undefined) {
  const accept = vi.fn(async (input: AcceptFinancialOperation) => ({
    created: true,
    operation: {
      ...input,
      operationId: "00000000-0000-4000-8000-000000000005",
      state: "ACCEPTED",
      attempts: 0,
      transaction: null,
      finalizedBlockNumber: null,
      finalizedBlockHash: null,
      failureCode: null,
    } as FinancialOperation,
  }));
  const service = new VendorVoucherSettlementService({
    journal: { accept },
    manifest: {
      schemaVersion: 1,
      chainId: 10_143,
      events: [
        {
          eventId,
          router: "0x0000000000000000000000000000000000000101",
          vault,
          ledger: "0x0000000000000000000000000000000000000707",
          asset: "0x0000000000000000000000000000000000000303",
          deploymentBlock: 1n,
        },
      ],
    },
    channel: async () => channel,
    maximumLifetimeSeconds: 3_600n,
    chainSeconds: async () => nowSeconds,
  });
  const submit = (overrides: Partial<OfflineVoucher> = {}) =>
    service.accept({
      identity,
      channelId,
      voucher: encodeOfflineVoucher({ ...voucher, ...overrides }),
      attendeeSignature: signature,
      terminalSignature: signature,
      idempotencyKey: "voucher:channel:0001",
    });
  return { accept, submit };
}

const open: FinalizedChannel = {
  vendorId,
  nextSequence: 1,
  submitUntil: BigInt(voucher.submitUntil),
  reclaimed: false,
};

it("journals a vault settleVoucher call for the vendor's own open channel", async () => {
  const { accept, submit } = build(open);
  await expect(submit()).resolves.toMatchObject({
    kind: "VOUCHER_SETTLE",
    aggregateId: voucher.paymentId,
  });
  const journaled = accept.mock.calls[0]?.[0];
  expect(journaled?.targetAddress).toBe(vault);
  expect(journaled?.actorId.startsWith("vendor-treasury:")).toBe(true);
  // Never outlives the chain's own submission cutoff.
  expect(journaled?.expiresAt.getTime()).toBe(voucher.submitUntil * 1_000);
  const decoded = decodeFunctionData({
    abi: resilienceVaultAbi,
    data: journaled?.calldata ?? "0x",
  });
  expect(decoded.functionName).toBe("settleVoucher");
});

it("refuses to sponsor another vendor's, a settled, or a closed channel", async () => {
  const other = build({ ...open, vendorId: keccak256(stringToHex("other-vendor")) });
  await expect(other.submit()).rejects.toThrow(VoucherChannelNotFound);
  const settled = build({ ...open, nextSequence: 2 });
  await expect(settled.submit()).rejects.toThrow(VendorCommandRejected);
  const closed = build({ ...open, submitUntil: nowSeconds });
  await expect(
    closed.submit({ acceptUntil: Number(nowSeconds) - 10, submitUntil: Number(nowSeconds) }),
  ).rejects.toThrow("Voucher submission window has closed");
  const unknown = build(undefined);
  await expect(unknown.submit()).rejects.toThrow(VoucherChannelNotFound);
  expect(other.accept).not.toHaveBeenCalled();
});
