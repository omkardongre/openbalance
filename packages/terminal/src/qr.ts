import {
  type AttendeeVoucherResponse,
  decodeOfflineVoucher,
  encodeAttendeeResponseQr,
  InvalidOfflineExchange,
  offlineVoucherDigest,
  paymentRequestHash,
  type TerminalPaymentRequest,
  type VoucherReceipt,
} from "@openbalance/protocol";
import { getAddress, type Hex, recoverAddress } from "viem";

export type { AttendeeVoucherResponse, TerminalPaymentRequest } from "@openbalance/protocol";
export {
  decodeAttendeeResponseQr,
  decodePaymentRequestQr,
  encodeAttendeeResponseQr,
  encodePaymentRequestQr,
  InvalidOfflineExchange as InvalidQrExchange,
  paymentRequestHash,
} from "@openbalance/protocol";

export async function verifyAttendeeResponse(input: {
  request: TerminalPaymentRequest;
  response: AttendeeVoucherResponse;
  attendeeSigner: `0x${string}`;
  nowSeconds: number;
}): Promise<Hex> {
  paymentRequestHash(input.request);
  encodeAttendeeResponseQr(input.response);
  if (
    !Number.isSafeInteger(input.nowSeconds) ||
    input.nowSeconds < 0 ||
    input.nowSeconds > input.request.expiresAt ||
    input.response.requestHash.toLowerCase() !== paymentRequestHash(input.request).toLowerCase()
  )
    throw new InvalidOfflineExchange("Attendee response is expired or targets another request");
  const voucher = decodeOfflineVoucher(input.request.voucher);
  let recovered: `0x${string}`;
  try {
    recovered = await recoverAddress({
      hash: offlineVoucherDigest(voucher),
      signature: input.response.attendeeSignature,
    });
  } catch {
    throw new InvalidOfflineExchange("Attendee signature is invalid");
  }
  if (getAddress(recovered) !== getAddress(input.attendeeSigner))
    throw new InvalidOfflineExchange("Attendee signature does not match channel authority");
  return input.response.attendeeSignature;
}

export function receiptFromExchange(input: {
  request: TerminalPaymentRequest;
  receiptId: string;
  attendeeSignature: Hex;
  terminalSignature: Hex;
}): VoucherReceipt {
  return {
    receiptId: input.receiptId,
    terminalId: input.request.terminalId,
    channelId: input.request.channelId,
    sequence: input.request.sequence,
    paymentId: input.request.paymentId,
    voucher: input.request.voucher,
    attendeeSignature: input.attendeeSignature,
    terminalSignature: input.terminalSignature,
  };
}
