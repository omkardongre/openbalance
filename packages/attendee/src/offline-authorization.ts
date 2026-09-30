import {
  decodeOfflineVoucher,
  offlineVoucherDigest,
  paymentRequestHash,
  type ReserveChannelConfig,
  type TerminalPaymentRequest,
  type VoucherReceipt,
  validateReserveChannelConfig,
} from "@openbalance/protocol";
import { type Address, getAddress, type Hex, isAddress, recoverAddress } from "viem";

export type AttendeeChannelState = {
  schemaVersion: 1;
  revision: number;
  status: "ACTIVE" | "RECLAIMED";
  keyId: string;
  signer: Address;
  chainId: bigint;
  vault: Address;
  terminalSigner: Address;
  channelId: Hex;
  eventId: Hex;
  vendorId: Hex;
  terminalId: Hex;
  configVersion: bigint;
  reserveUnits: bigint;
  spentUnits: bigint;
  maxPerVoucher: bigint;
  maxVoucherCount: number;
  approvedVoucherCount: number;
  nextSequence: number;
  lastVoucherDigest: Hex;
  acceptFrom: number;
  acceptUntil: number;
  submitUntil: number;
  display: {
    vendorName: string;
    assetSymbol: string;
    assetDecimals: number;
  };
};

export type PreparedAttendeeAuthorization = {
  request: TerminalPaymentRequest;
  requestHash: Hex;
  voucherDigest: Hex;
  grossUnits: bigint;
  cumulativeGrossUnits: bigint;
  /** The earlier, never-confirmed approval this one replaces at the same sequence, if any. */
  supersededPaymentId: Hex | null;
  nextState: AttendeeChannelState;
};

export class OfflineAuthorizationRejected extends Error {}

const sameHex = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function createAttendeeChannelState(input: {
  keyId: string;
  signer: Address;
  chainId: bigint;
  vault: Address;
  terminalSigner: Address;
  config: ReserveChannelConfig;
  display: AttendeeChannelState["display"];
}): AttendeeChannelState {
  const { config } = input;
  validateReserveChannelConfig(config);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.keyId) ||
    getAddress(input.signer) !== getAddress(config.attendeeChannelSigner) ||
    input.chainId < 1n ||
    !isAddress(input.vault) ||
    input.vault === "0x0000000000000000000000000000000000000000" ||
    !isAddress(input.terminalSigner) ||
    input.terminalSigner === "0x0000000000000000000000000000000000000000" ||
    !input.display.vendorName.trim() ||
    !/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(input.display.assetSymbol) ||
    !Number.isInteger(input.display.assetDecimals) ||
    input.display.assetDecimals < 0 ||
    input.display.assetDecimals > 36
  )
    throw new OfflineAuthorizationRejected("Invalid attendee channel binding");
  return {
    schemaVersion: 1,
    revision: 1,
    status: "ACTIVE",
    keyId: input.keyId,
    signer: getAddress(input.signer),
    chainId: input.chainId,
    vault: getAddress(input.vault),
    terminalSigner: getAddress(input.terminalSigner),
    channelId: config.channelId,
    eventId: config.eventId,
    vendorId: config.vendorId,
    terminalId: config.terminalInstanceId,
    configVersion: config.configVersion,
    reserveUnits: config.reserveUnits,
    spentUnits: 0n,
    maxPerVoucher: config.maxPerVoucher,
    maxVoucherCount: config.maxVoucherCount,
    approvedVoucherCount: 0,
    nextSequence: 1,
    lastVoucherDigest: config.genesisDigest,
    acceptFrom: config.acceptFrom,
    acceptUntil: config.acceptUntil,
    submitUntil: config.submitUntil,
    display: {
      vendorName: input.display.vendorName.trim(),
      assetSymbol: input.display.assetSymbol,
      assetDecimals: input.display.assetDecimals,
    },
  };
}

/** The newest local approval on a channel, as the caller stored it. */
export type UnconfirmedTipAuthorization = {
  paymentId: Hex;
  request: TerminalPaymentRequest;
  receipt: VoucherReceipt | null;
};

/**
 * Rewinds the channel cursor past the newest approval when the terminal has visibly abandoned it.
 *
 * The attendee advances its cursor when it signs, but a voucher settles only with the terminal's
 * countersignature, which a compliant terminal gives only before the request's `expiresAt` and
 * only while it still holds that sequence. A terminal that never received the response in time
 * releases the sequence and asks again at the same position; without this the channel would be
 * stuck for good. Rewinding is allowed only when every condition holds:
 * - the approval has no terminal receipt (the terminal never confirmed it);
 * - it is the channel tip, so nothing was chained after it;
 * - its request has expired on this device's clock, and the new request is for another payment
 *   at the same sequence and previous digest, which a compliant terminal issues only after
 *   releasing the old one.
 * Safety does not rest on the terminal being honest: the vault settles each sequence once, so a
 * terminal that countersigned both vouchers still gets only one of them, bounded by
 * `maxPerVoucher` and the reserve.
 */
function rewindUnconfirmedTip(
  state: AttendeeChannelState,
  tip: UnconfirmedTipAuthorization,
  request: TerminalPaymentRequest,
  voucher: ReturnType<typeof decodeOfflineVoucher>,
  nowSeconds: number,
): AttendeeChannelState {
  const tipVoucher = decodeOfflineVoucher(tip.request.voucher);
  if (
    tip.receipt !== null ||
    !sameHex(tip.paymentId, tip.request.paymentId) ||
    sameHex(tip.paymentId, request.paymentId) ||
    !sameHex(tip.request.channelId, state.channelId) ||
    !sameHex(tip.request.terminalId, state.terminalId) ||
    !sameHex(tipVoucher.channelId, state.channelId) ||
    tipVoucher.sequence !== state.nextSequence - 1 ||
    !sameHex(offlineVoucherDigest(tipVoucher), state.lastVoucherDigest) ||
    tipVoucher.cumulativeGrossUnits !== state.spentUnits ||
    state.approvedVoucherCount < 1 ||
    nowSeconds <= tip.request.expiresAt ||
    voucher.sequence !== tipVoucher.sequence ||
    !sameHex(voucher.previousVoucherDigest, tipVoucher.previousVoucherDigest)
  )
    throw new OfflineAuthorizationRejected(
      "Offline request is expired, duplicated, or outside the activated channel",
    );
  return {
    ...state,
    spentUnits: tipVoucher.cumulativeGrossUnits - tipVoucher.grossUnits,
    approvedVoucherCount: state.approvedVoucherCount - 1,
    nextSequence: tipVoucher.sequence,
    lastVoucherDigest: tipVoucher.previousVoucherDigest,
  };
}

export function prepareAttendeeAuthorization(input: {
  state: AttendeeChannelState;
  request: TerminalPaymentRequest;
  nowSeconds: number;
  paymentAlreadyAuthorized: boolean;
  /**
   * The newest local approval on this channel, if any. Supplied so that a request re-issued at
   * that approval's sequence can supersede it; see `rewindUnconfirmedTip` for the conditions.
   */
  tip?: UnconfirmedTipAuthorization | undefined;
}): PreparedAttendeeAuthorization {
  const { request } = input;
  const voucher = decodeOfflineVoucher(request.voucher);
  const supersedes =
    input.tip !== undefined && voucher.sequence === input.state.nextSequence - 1
      ? input.tip
      : undefined;
  const state = supersedes
    ? rewindUnconfirmedTip(input.state, supersedes, request, voucher, input.nowSeconds)
    : input.state;
  const expectedCumulative = state.spentUnits + voucher.grossUnits;
  if (
    state.schemaVersion !== 1 ||
    state.status !== "ACTIVE" ||
    !Number.isSafeInteger(input.nowSeconds) ||
    input.nowSeconds < state.acceptFrom ||
    input.nowSeconds >= state.acceptUntil ||
    input.nowSeconds > request.expiresAt ||
    input.paymentAlreadyAuthorized ||
    !sameHex(request.terminalId, state.terminalId) ||
    !sameHex(request.channelId, state.channelId) ||
    !sameHex(voucher.channelId, state.channelId) ||
    !sameHex(voucher.vault, state.vault) ||
    voucher.chainId !== state.chainId ||
    voucher.configVersion !== state.configVersion ||
    voucher.sequence !== state.nextSequence ||
    !sameHex(voucher.previousVoucherDigest, state.lastVoucherDigest) ||
    voucher.grossUnits > state.maxPerVoucher ||
    expectedCumulative > state.reserveUnits ||
    voucher.cumulativeGrossUnits !== expectedCumulative ||
    voucher.acceptedAt < state.acceptFrom ||
    voucher.acceptedAt >= state.acceptUntil ||
    voucher.acceptUntil !== state.acceptUntil ||
    voucher.submitUntil !== state.submitUntil ||
    state.approvedVoucherCount >= state.maxVoucherCount
  )
    throw new OfflineAuthorizationRejected(
      "Offline request is expired, duplicated, or outside the activated channel",
    );

  const digest = offlineVoucherDigest(voucher);
  return {
    request,
    requestHash: paymentRequestHash(request),
    voucherDigest: digest,
    grossUnits: voucher.grossUnits,
    cumulativeGrossUnits: voucher.cumulativeGrossUnits,
    supersededPaymentId: supersedes?.paymentId ?? null,
    nextState: {
      ...state,
      revision: input.state.revision + 1,
      spentUnits: voucher.cumulativeGrossUnits,
      approvedVoucherCount: state.approvedVoucherCount + 1,
      nextSequence: state.nextSequence + 1,
      lastVoucherDigest: digest,
    },
  };
}

export async function verifyTerminalReceiptForAuthorization(input: {
  state: AttendeeChannelState;
  request: TerminalPaymentRequest;
  attendeeSignature: Hex;
  receipt: VoucherReceipt;
}): Promise<void> {
  const { receipt, request, state } = input;
  if (
    !sameHex(receipt.channelId, state.channelId) ||
    !sameHex(receipt.channelId, request.channelId) ||
    !sameHex(receipt.terminalId, state.terminalId) ||
    !sameHex(receipt.terminalId, request.terminalId) ||
    !sameHex(receipt.paymentId, request.paymentId) ||
    receipt.sequence !== request.sequence ||
    !sameHex(receipt.voucher, request.voucher) ||
    !sameHex(receipt.attendeeSignature, input.attendeeSignature)
  )
    throw new OfflineAuthorizationRejected(
      "Terminal receipt does not match the locally authorized purchase",
    );
  const digest = offlineVoucherDigest(decodeOfflineVoucher(receipt.voucher));
  let attendee: Address;
  let terminal: Address;
  try {
    [attendee, terminal] = await Promise.all([
      recoverAddress({ hash: digest, signature: receipt.attendeeSignature }),
      recoverAddress({ hash: digest, signature: receipt.terminalSignature }),
    ]);
  } catch {
    throw new OfflineAuthorizationRejected("Terminal receipt signature is invalid");
  }
  if (getAddress(attendee) !== state.signer || getAddress(terminal) !== state.terminalSigner)
    throw new OfflineAuthorizationRejected("Terminal receipt signature authority does not match");
}
