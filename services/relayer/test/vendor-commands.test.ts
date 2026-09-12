import { exactPayRouterAbi, type RefundIntent, refundIntentDigest } from "@openbalance/protocol";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it, vi } from "vitest";
import type { AcceptFinancialOperation, FinancialOperation } from "../src/financial-operations.js";
import { VendorCommandRejected, VendorFinancialCommandService } from "../src/vendor-commands.js";

const authority = privateKeyToAccount(`0x${"42".repeat(32)}`);
const eventId = keccak256(stringToHex("vendor-event"));
const vendorId = keccak256(stringToHex("vendor-id"));
const paymentId = keccak256(stringToHex("vendor-payment"));
const router = "0x0000000000000000000000000000000000000101";
const ledger = "0x0000000000000000000000000000000000000707";
const nowSeconds = 1_800_000_000;
const identity = {
  credentialId: "00000000-0000-4000-8000-000000000003",
  eventId,
  vendorId,
  authorityAddress: authority.address,
};

function build() {
  const accept = vi.fn(async (input: AcceptFinancialOperation) => ({
    created: true,
    operation: {
      ...input,
      operationId: "00000000-0000-4000-8000-000000000004",
      state: "ACCEPTED",
      attempts: 0,
      transaction: null,
      finalizedBlockNumber: null,
      finalizedBlockHash: null,
      failureCode: null,
    } as FinancialOperation,
  }));
  return {
    accept,
    service: new VendorFinancialCommandService({
      journal: { accept, getForActor: vi.fn() },
      manifest: {
        schemaVersion: 1,
        chainId: 10_143,
        events: [
          {
            eventId,
            router,
            vault: "0x0000000000000000000000000000000000000606",
            ledger,
            asset: "0x0000000000000000000000000000000000000303",
            deploymentBlock: 1n,
          },
        ],
      },
      now: () => new Date(nowSeconds * 1_000),
    }),
  };
}

it("accepts only treasury-signed refunds in the credential event and vendor scope", async () => {
  const intent: RefundIntent = {
    schemaVersion: 1,
    chainId: 10_143n,
    router,
    eventId,
    refundId: keccak256(stringToHex("refund-id")),
    paymentId,
    payerAccount: "0x0000000000000000000000000000000000000202",
    vendorId,
    asset: "0x0000000000000000000000000000000000000303",
    refundUnits: 2_000_000n,
    cumulativeRefundUnits: 2_000_000n,
    vendorCreditUnits: 1_000_000n,
    fundingSource: authority.address,
    validAfter: nowSeconds - 1,
    expiresAt: nowSeconds + 300,
  };
  const signed = await authority.sign({ hash: refundIntentDigest(intent) });
  const calldata = encodeFunctionData({
    abi: exactPayRouterAbi,
    functionName: "refund",
    args: [intent, signed],
  });
  const { accept, service } = build();
  await expect(
    service.acceptRefund({
      identity,
      paymentId,
      calldata,
      idempotencyKey: "refund:vendor:0001",
    }),
  ).resolves.toMatchObject({ kind: "REFUND", aggregateId: intent.refundId });
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ targetAddress: router, commandDigest: keccak256(calldata) }),
  );

  await expect(
    service.acceptRefund({
      identity: { ...identity, vendorId: keccak256(stringToHex("other-vendor")) },
      paymentId,
      calldata,
      idempotencyKey: "refund:vendor:0002",
    }),
  ).rejects.toBeInstanceOf(VendorCommandRejected);
});
