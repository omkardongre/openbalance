import {
  cursorKey,
  decodeChannelResponseQr,
  decodeOfflineVoucher,
  decodeOpenPaymentRequestQr,
  encodeChannelResponseQr,
  encodeOpenPaymentRequestQr,
  InvalidOfflineExchange,
  type OpenPaymentRequest,
  offlineVoucherDigest,
  openRequestHash,
  type ReserveChannelConfig,
} from "@openbalance/protocol";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  canPayOpenRequest,
  createAttendeeChannelState,
  OfflineAuthorizationRejected,
  prepareOpenAuthorization,
} from "../src/offline-authorization.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const attendee = privateKeyToAccount(hex32("1"));
const vault = getAddress("0x2222222222222222222222222222222222222222");
const config: ReserveChannelConfig = {
  channelId: hex32("3"),
  eventId: hex32("4"),
  asset: getAddress("0x5555555555555555555555555555555555555555"),
  reserveUnits: 1_000n,
  vendorId: hex32("6"),
  vendorDestinationVersion: 1n,
  terminalInstanceId: hex32("7"),
  terminalKeyVersion: 1n,
  attendeeChannelSigner: attendee.address,
  configVersion: 2n,
  organizerFeeBps: 100,
  platformFeeBps: 50,
  maxPerVoucher: 400n,
  maxVoucherCount: 3,
  acceptFrom: 100,
  acceptUntil: 200,
  submitUntil: 250,
  genesisDigest: hex32("8"),
};
const state = createAttendeeChannelState({
  keyId: "channel-key:1",
  signer: attendee.address,
  chainId: 10_143n,
  vault,
  terminalSigner: privateKeyToAccount(hex32("2")).address,
  config,
  display: { vendorName: "Noodles", assetSymbol: "USDC", assetDecimals: 6 },
});

function request(overrides: Partial<OpenPaymentRequest> = {}): OpenPaymentRequest {
  return {
    version: 2,
    kind: "offline-payment-request",
    requestId: "request:1",
    terminalId: config.terminalInstanceId,
    paymentId: hex32("9"),
    orderRefHash: hex32("a"),
    receiptCommitment: hex32("b"),
    grossUnits: "150",
    acceptedAt: 120,
    expiresAt: 180,
    cursors: [`${cursorKey(config.channelId)}:1`],
    ...overrides,
  };
}

describe("open payment request codec", () => {
  it("round-trips canonically and pins the shared hash vector", () => {
    const qr = encodeOpenPaymentRequestQr(request());
    expect(decodeOpenPaymentRequestQr(qr)).toEqual(request());
    // The Android terminal hashes the same canonical bytes; OfflineProtocolTest pins this value.
    expect(openRequestHash(request())).toBe(
      "0xa51678951f457caeca8dacfe1abdee0b420d38fb66a624c4995d941cda0a0244",
    );
  });

  it("rejects unsorted or malformed reserve positions", () => {
    for (const cursors of [[], ["333333333333:0"], ["bbbbbbbbbbbb:1", "aaaaaaaaaaaa:1"], ["x:1"]])
      expect(() => encodeOpenPaymentRequestQr(request({ cursors }))).toThrow(
        InvalidOfflineExchange,
      );
  });

  it("round-trips the reserve-carrying response", () => {
    const response = {
      version: 2 as const,
      kind: "offline-voucher-response" as const,
      requestHash: hex32("c"),
      channelId: config.channelId,
      attendeeSignature: `0x${"d".repeat(130)}` as Hex,
    };
    expect(decodeChannelResponseQr(encodeChannelResponseQr(response))).toEqual(response);
  });
});

describe("customer-chosen reserve authorization", () => {
  it("builds the voucher at the position the terminal listed", async () => {
    const prepared = prepareOpenAuthorization({
      state,
      request: request(),
      nowSeconds: 130,
      paymentAlreadyAuthorized: false,
    });
    const voucher = decodeOfflineVoucher(prepared.voucher);
    expect(voucher).toMatchObject({
      channelId: config.channelId,
      sequence: 1,
      previousVoucherDigest: config.genesisDigest,
      grossUnits: 150n,
      cumulativeGrossUnits: 150n,
      acceptUntil: 200,
      submitUntil: 250,
    });
    expect(prepared.voucherDigest).toBe(offlineVoucherDigest(voucher));
    expect(prepared.nextState).toMatchObject({ nextSequence: 2, spentUnits: 150n });
    expect(await attendee.sign({ hash: prepared.voucherDigest })).toMatch(/^0x/);
  });

  it("refuses a reserve the terminal did not list, another stall, or too little money", () => {
    const cases: Partial<OpenPaymentRequest>[] = [
      { cursors: ["000000000000:1"] },
      { terminalId: hex32("e") },
      { grossUnits: "401" },
      { cursors: [`${cursorKey(config.channelId)}:2`] },
    ];
    for (const overrides of cases) {
      if (!overrides.cursors?.[0]?.endsWith(":2"))
        expect(canPayOpenRequest(state, request(overrides), 130)).toBe(false);
      expect(() =>
        prepareOpenAuthorization({
          state,
          request: request(overrides),
          nowSeconds: 130,
          paymentAlreadyAuthorized: false,
        }),
      ).toThrow(OfflineAuthorizationRejected);
    }
  });

  it("replaces an approval the terminal never countersigned once it expired", () => {
    const first = prepareOpenAuthorization({
      state,
      request: request(),
      nowSeconds: 130,
      paymentAlreadyAuthorized: false,
    });
    const tip = { paymentId: hex32("9"), voucher: first.voucher, expiresAt: 180, receipt: null };
    const again = request({
      requestId: "request:2",
      paymentId: hex32("f"),
      acceptedAt: 185,
      expiresAt: 195,
    });
    // Terminal still at position 1: it never accepted the first approval.
    const replaced = prepareOpenAuthorization({
      state: first.nextState,
      request: again,
      nowSeconds: 186,
      paymentAlreadyAuthorized: false,
      tip,
    });
    expect(replaced.sequence).toBe(1);
    expect(replaced.supersededPaymentId).toBe(hex32("9"));
    expect(replaced.nextState).toMatchObject({ nextSequence: 2, spentUnits: 150n });
    // Not before that approval's request expired.
    expect(() =>
      prepareOpenAuthorization({
        state: first.nextState,
        request: again,
        nowSeconds: 175,
        paymentAlreadyAuthorized: false,
        tip,
      }),
    ).toThrow(OfflineAuthorizationRejected);
    // Terminal at position 2 means it accepted the first one: sign the next position instead.
    const next = prepareOpenAuthorization({
      state: first.nextState,
      request: { ...again, cursors: [`${cursorKey(config.channelId)}:2`] },
      nowSeconds: 186,
      paymentAlreadyAuthorized: false,
      tip,
    });
    expect(next.sequence).toBe(2);
    expect(next.supersededPaymentId).toBeNull();
    expect(next.cumulativeGrossUnits).toBe(300n);
  });
});
