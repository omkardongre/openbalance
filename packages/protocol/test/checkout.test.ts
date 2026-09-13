import { expect, it } from "vitest";
import {
  decodeCheckoutCapability,
  decodeResolvedCheckoutRequest,
  encodeCheckoutCapability,
  encodePaymentIntent,
  orderReferenceHash,
  receiptCommitment,
} from "../src/index.js";

const display = {
  vendorName: "Market Kitchen",
  orderReference: "ORDER-1042",
  orderVersion: "3",
  description: "Lunch order",
  assetSymbol: "USDC",
  assetDecimals: 6,
};

it("binds attendee-visible checkout details to the encoded payment intent", () => {
  const intent = {
    schemaVersion: 1,
    chainId: 10_143n,
    router: "0x0000000000000000000000000000000000000101" as const,
    eventId: `0x${"11".repeat(32)}` as const,
    paymentId: `0x${"22".repeat(32)}` as const,
    payerAccount: "0x0000000000000000000000000000000000000202" as const,
    orderRefHash: orderReferenceHash(display.orderReference, 3n),
    vendorId: `0x${"33".repeat(32)}` as const,
    vendorDestinationVersion: 1n,
    terminalInstanceId: `0x${"44".repeat(32)}` as const,
    asset: "0x0000000000000000000000000000000000000303" as const,
    grossUnits: 12_500_000n,
    organizerFeeBps: 200,
    platformFeeBps: 100,
    configVersion: 1n,
    receiptCommitment: receiptCommitment({ ...display, orderVersion: 3n, grossUnits: 12_500_000n }),
    validAfter: 1_800_000_000,
    expiresAt: 1_800_000_300,
    terminalKeyVersion: 1n,
  };
  expect(
    decodeResolvedCheckoutRequest({
      schemaVersion: 1,
      orderId: "00000000-0000-4000-8000-000000000001",
      encodedIntent: encodePaymentIntent(intent),
      terminalSignature: `0x${"55".repeat(65)}`,
      display,
      reservePolicy: {
        vault: "0x0000000000000000000000000000000000000606",
        maximumReserveUnits: "50000000",
        maximumPerVoucherUnits: "15000000",
        maximumVoucherCount: 8,
        acceptanceDurationSeconds: 3600,
        submissionDelaySeconds: 7200,
      },
    }).intent,
  ).toEqual(intent);

  const capability = {
    schemaVersion: 1 as const,
    orderId: "00000000-0000-4000-8000-000000000001",
    capability: "a".repeat(43),
  };
  expect(decodeCheckoutCapability(encodeCheckoutCapability(capability))).toEqual(capability);
});
