import {
  decodeOfflineVoucher,
  encodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
  type ReserveChannelConfig,
} from "@openbalance/protocol";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  createAttendeeChannelState,
  OfflineAuthorizationRejected,
  prepareAttendeeAuthorization,
  verifyTerminalReceiptForAuthorization,
} from "../src/offline-authorization.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const attendeeAccount = privateKeyToAccount(hex32("1"));
const terminalAccount = privateKeyToAccount(hex32("2"));
const signer = attendeeAccount.address;
const vault = getAddress("0x2222222222222222222222222222222222222222");
const terminalSigner = terminalAccount.address;
const config: ReserveChannelConfig = {
  channelId: hex32("3"),
  eventId: hex32("4"),
  asset: getAddress("0x5555555555555555555555555555555555555555"),
  reserveUnits: 1_000n,
  vendorId: hex32("6"),
  vendorDestinationVersion: 1n,
  terminalInstanceId: hex32("7"),
  terminalKeyVersion: 1n,
  attendeeChannelSigner: signer,
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
  signer,
  chainId: 10_143n,
  vault,
  terminalSigner,
  config,
  display: { vendorName: "Noodles", assetSymbol: "USDC", assetDecimals: 6 },
});

function request(overrides: Partial<OfflineVoucher> = {}) {
  const voucher: OfflineVoucher = {
    protocolVersion: 1,
    chainId: state.chainId,
    vault,
    channelId: config.channelId,
    sequence: 1,
    previousVoucherDigest: config.genesisDigest,
    paymentId: hex32("9"),
    orderRefHash: hex32("a"),
    grossUnits: 150n,
    cumulativeGrossUnits: 150n,
    receiptCommitment: hex32("b"),
    acceptedAt: 120,
    acceptUntil: 200,
    submitUntil: 250,
    configVersion: 2n,
    ...overrides,
  };
  return {
    version: 1 as const,
    kind: "offline-payment-request" as const,
    requestId: "request:1",
    terminalId: config.terminalInstanceId,
    channelId: config.channelId,
    paymentId: voucher.paymentId,
    sequence: voucher.sequence,
    voucher: encodeOfflineVoucher(voucher),
    expiresAt: 180,
  };
}

describe("attendee offline authorization", () => {
  it("advances the exact activated channel chain", () => {
    const prepared = prepareAttendeeAuthorization({
      state,
      request: request(),
      nowSeconds: 130,
      paymentAlreadyAuthorized: false,
    });
    expect(prepared.nextState).toMatchObject({
      revision: 2,
      spentUnits: 150n,
      approvedVoucherCount: 1,
      nextSequence: 2,
      lastVoucherDigest: prepared.voucherDigest,
    });
  });

  it("rejects duplicate, expired, out-of-sequence, and over-cap requests", () => {
    const cases = [
      { request: request(), nowSeconds: 130, paymentAlreadyAuthorized: true },
      { request: request(), nowSeconds: 201, paymentAlreadyAuthorized: false },
      { request: request({ sequence: 2 }), nowSeconds: 130, paymentAlreadyAuthorized: false },
      {
        request: request({ grossUnits: 401n, cumulativeGrossUnits: 401n }),
        nowSeconds: 130,
        paymentAlreadyAuthorized: false,
      },
    ];
    for (const candidate of cases)
      expect(() => prepareAttendeeAuthorization({ state, ...candidate })).toThrow(
        OfflineAuthorizationRejected,
      );
  });

  it("verifies the returned receipt against both channel authorities", async () => {
    const terminalRequest = request();
    const digest = offlineVoucherDigest(decodeOfflineVoucher(terminalRequest.voucher));
    const attendeeSignature = await attendeeAccount.sign({ hash: digest });
    await expect(
      verifyTerminalReceiptForAuthorization({
        state,
        request: terminalRequest,
        attendeeSignature,
        receipt: {
          receiptId: "receipt:1",
          terminalId: state.terminalId,
          channelId: state.channelId,
          sequence: 1,
          paymentId: terminalRequest.paymentId,
          voucher: terminalRequest.voucher,
          attendeeSignature,
          terminalSignature: await terminalAccount.sign({ hash: digest }),
        },
      }),
    ).resolves.toBeUndefined();
  });
});
