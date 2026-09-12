import { accountAbi, encodePaymentIntent, exactPayRouterAbi } from "@openbalance/protocol";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { expect, it } from "vitest";
import type { FinancialOperation } from "../src/financial-operations.js";
import { expectedFinancialEvent } from "../src/viem-financial-finality.js";

it("requires the finalized payment event to match the exact authorized economics", () => {
  const account = "0x0000000000000000000000000000000000000202";
  const router = "0x0000000000000000000000000000000000000101";
  const paymentId = keccak256(stringToHex("finality-payment"));
  const intent = {
    schemaVersion: 1,
    chainId: 10_143n,
    router,
    eventId: keccak256(stringToHex("finality-event")),
    paymentId,
    payerAccount: account,
    orderRefHash: keccak256(stringToHex("finality-order")),
    vendorId: keccak256(stringToHex("finality-vendor")),
    vendorDestinationVersion: 1n,
    terminalInstanceId: keccak256(stringToHex("finality-terminal")),
    asset: "0x0000000000000000000000000000000000000303",
    grossUnits: 5_000_000n,
    organizerFeeBps: 200,
    platformFeeBps: 100,
    configVersion: 1n,
    receiptCommitment: keccak256(stringToHex("finality-receipt")),
    validAfter: 1_800_000_000,
    expiresAt: 1_800_000_300,
    terminalKeyVersion: 1n,
  } as const;
  const calldata = encodeFunctionData({
    abi: accountAbi,
    functionName: "payWithOnlineSession",
    args: [
      keccak256(stringToHex("session")),
      encodePaymentIntent(intent),
      `0x${"33".repeat(65)}`,
      `0x${"11".repeat(32)}`,
      `0x${"22".repeat(32)}`,
    ],
  });
  const operation = {
    kind: "PAYMENT",
    aggregateId: paymentId,
    targetAddress: account,
    calldata,
  } as unknown as FinancialOperation;
  const expected = expectedFinancialEvent(operation);
  const matchingArgs = {
    paymentId,
    payer: account,
    vendorId: intent.vendorId,
    configVersion: 1n,
    gross: intent.grossUnits,
    organizerFee: 100_000n,
    platformFee: 50_000n,
    receiptCommitment: intent.receiptCommitment,
  };
  expect(expected.address).toBe(router);
  expect(expected.abi).toBe(exactPayRouterAbi);
  expect(expected.matches(matchingArgs)).toBe(true);
  expect(expected.matches({ ...matchingArgs, gross: intent.grossUnits + 1n })).toBe(false);
});
