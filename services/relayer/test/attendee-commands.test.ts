import { accountAbi, encodePaymentIntent, type PaymentIntent } from "@openbalance/protocol";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { expect, it, vi } from "vitest";
import {
  AttendeeCommandRejected,
  AttendeeFinancialCommandService,
} from "../src/attendee-commands.js";
import type { AcceptFinancialOperation, FinancialOperation } from "../src/financial-operations.js";

const account = "0x0000000000000000000000000000000000000202";
const router = "0x0000000000000000000000000000000000000101";
const vault = "0x0000000000000000000000000000000000000606";
const asset = "0x0000000000000000000000000000000000000303";
const eventId = keccak256(stringToHex("event:market-2026"));
const nowSeconds = 1_800_000_000;
const intent: PaymentIntent = {
  schemaVersion: 1,
  chainId: 10_143n,
  router,
  eventId,
  paymentId: keccak256(stringToHex("payment:command:1")),
  payerAccount: account,
  orderRefHash: keccak256(stringToHex("order:command:1")),
  vendorId: keccak256(stringToHex("vendor:command:1")),
  vendorDestinationVersion: 1n,
  terminalInstanceId: keccak256(stringToHex("terminal:command:1")),
  asset,
  grossUnits: 12_000_000n,
  organizerFeeBps: 200,
  platformFeeBps: 100,
  configVersion: 1n,
  receiptCommitment: keccak256(stringToHex("receipt:command:1")),
  validAfter: nowSeconds - 5,
  expiresAt: nowSeconds + 300,
  terminalKeyVersion: 1n,
};
const auth = {
  r: `0x${"11".repeat(32)}` as const,
  s: `0x${"22".repeat(32)}` as const,
  challengeIndex: 0n,
  typeIndex: 1n,
  authenticatorData: "0x0102" as const,
  clientDataJSON: "{}",
};

function paymentCalldata(value = intent) {
  return encodeFunctionData({
    abi: accountAbi,
    functionName: "pay",
    args: [
      router,
      encodePaymentIntent(value),
      `0x${"33".repeat(65)}`,
      BigInt(value.expiresAt),
      false,
      auth,
    ],
  });
}

function service() {
  const accept = vi.fn(async (input: AcceptFinancialOperation) => ({
    created: true,
    operation: {
      ...input,
      operationId: "00000000-0000-4000-8000-000000000001",
      requestHash: keccak256(input.calldata),
      state: "ACCEPTED",
      attempts: 0,
      nextAttemptAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      transaction: null,
      replacementLineage: [],
      submittedAt: null,
      finalizedAt: null,
      finalizedBlockNumber: null,
      finalizedBlockHash: null,
      failureCode: null,
    } as FinancialOperation,
  }));
  return {
    accept,
    commands: new AttendeeFinancialCommandService({
      journal: { accept, getForActor: vi.fn() },
      chainId: 10_143n,
      events: [{ eventId, router, vault, asset }],
      now: () => new Date(nowSeconds * 1_000),
    }),
  };
}

it("derives payment scope and journal fields from an authenticated account command", async () => {
  const { accept, commands } = service();
  const result = await commands.accept(
    { enrollmentId: "enrollment-1", account },
    {
      kind: "PAYMENT",
      idempotencyKey: "payment:command:0001",
      calldata: paymentCalldata(),
    },
  );
  expect(result).toMatchObject({ created: true, kind: "PAYMENT", aggregateId: intent.paymentId });
  expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({
      actorId: `attendee:${account}`,
      targetAddress: account,
      aggregateId: intent.paymentId,
      commandDigest: keccak256(paymentCalldata()),
    }),
  );
});

it("rejects a validly encoded command for a different payer", async () => {
  const { commands } = service();
  await expect(
    commands.accept(
      { enrollmentId: "enrollment-1", account },
      {
        kind: "PAYMENT",
        idempotencyKey: "payment:command:0002",
        calldata: paymentCalldata({
          ...intent,
          payerAccount: "0x0000000000000000000000000000000000000999",
        }),
      },
    ),
  ).rejects.toBeInstanceOf(AttendeeCommandRejected);
});
