import {
  decodeOfflineVoucher,
  offlineVoucherDigest,
  type VoucherReceipt,
} from "@openbalance/protocol";
import { getAddress, type Hex, keccak256, recoverAddress, stringToHex } from "viem";

const prefix = "obqr1:";
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const signature = /^0x[0-9a-fA-F]{130}$/;

export class InvalidQrExchange extends Error {}

export type TerminalPaymentRequest = {
  version: 1;
  kind: "offline-payment-request";
  requestId: string;
  terminalId: Hex;
  channelId: Hex;
  paymentId: Hex;
  sequence: number;
  voucher: Hex;
  expiresAt: number;
};

export type AttendeeVoucherResponse = {
  version: 1;
  kind: "offline-voucher-response";
  requestHash: Hex;
  attendeeSignature: Hex;
};

function canonicalRequest(request: TerminalPaymentRequest): string {
  validateRequest(request);
  return JSON.stringify({
    version: 1,
    kind: "offline-payment-request",
    requestId: request.requestId,
    terminalId: request.terminalId.toLowerCase(),
    channelId: request.channelId.toLowerCase(),
    paymentId: request.paymentId.toLowerCase(),
    sequence: request.sequence,
    voucher: request.voucher.toLowerCase(),
    expiresAt: request.expiresAt,
  });
}

function canonicalResponse(response: AttendeeVoucherResponse): string {
  validateResponse(response);
  return JSON.stringify({
    version: 1,
    kind: "offline-voucher-response",
    requestHash: response.requestHash.toLowerCase(),
    attendeeSignature: response.attendeeSignature.toLowerCase(),
  });
}

function validateRequest(request: TerminalPaymentRequest): void {
  if (
    request.version !== 1 ||
    request.kind !== "offline-payment-request" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(request.requestId) ||
    !hex32.test(request.terminalId) ||
    !hex32.test(request.channelId) ||
    !hex32.test(request.paymentId) ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 1 ||
    request.sequence >= 2 ** 32 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(request.voucher) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt < 0
  )
    throw new InvalidQrExchange("Invalid terminal payment request");
  const voucher = decodeOfflineVoucher(request.voucher);
  if (
    voucher.channelId.toLowerCase() !== request.channelId.toLowerCase() ||
    voucher.paymentId.toLowerCase() !== request.paymentId.toLowerCase() ||
    voucher.sequence !== request.sequence ||
    request.expiresAt > voucher.acceptUntil ||
    request.expiresAt < voucher.acceptedAt
  )
    throw new InvalidQrExchange("Payment request does not match voucher");
}

function validateResponse(response: AttendeeVoucherResponse): void {
  if (
    response.version !== 1 ||
    response.kind !== "offline-voucher-response" ||
    !hex32.test(response.requestHash) ||
    !signature.test(response.attendeeSignature)
  )
    throw new InvalidQrExchange("Invalid attendee voucher response");
}

function encodeQr(canonical: string): string {
  const encoded = `${prefix}${Buffer.from(canonical, "utf8").toString("base64url")}`;
  if (encoded.length > 4_096) throw new InvalidQrExchange("QR payload exceeds supported size");
  return encoded;
}

function decodeQr(value: string): unknown {
  if (!value.startsWith(prefix) || value.length > 4_096)
    throw new InvalidQrExchange("Invalid QR envelope");
  try {
    const json = Buffer.from(value.slice(prefix.length), "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    throw new InvalidQrExchange("Invalid QR encoding");
  }
}

export function paymentRequestHash(request: TerminalPaymentRequest): Hex {
  return keccak256(stringToHex(canonicalRequest(request)));
}

export function encodePaymentRequestQr(request: TerminalPaymentRequest): string {
  return encodeQr(canonicalRequest(request));
}

export function decodePaymentRequestQr(value: string): TerminalPaymentRequest {
  const decoded = decodeQr(value);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new InvalidQrExchange("Invalid terminal payment request");
  const request = decoded as TerminalPaymentRequest;
  validateRequest(request);
  if (canonicalRequest(request) !== JSON.stringify(request))
    throw new InvalidQrExchange("QR request is not canonical");
  return request;
}

export function encodeAttendeeResponseQr(response: AttendeeVoucherResponse): string {
  return encodeQr(canonicalResponse(response));
}

export function decodeAttendeeResponseQr(value: string): AttendeeVoucherResponse {
  const decoded = decodeQr(value);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new InvalidQrExchange("Invalid attendee voucher response");
  const response = decoded as AttendeeVoucherResponse;
  validateResponse(response);
  if (canonicalResponse(response) !== JSON.stringify(response))
    throw new InvalidQrExchange("QR response is not canonical");
  return response;
}

export async function verifyAttendeeResponse(input: {
  request: TerminalPaymentRequest;
  response: AttendeeVoucherResponse;
  attendeeSigner: `0x${string}`;
  nowSeconds: number;
}): Promise<Hex> {
  validateRequest(input.request);
  validateResponse(input.response);
  if (
    !Number.isSafeInteger(input.nowSeconds) ||
    input.nowSeconds < 0 ||
    input.nowSeconds > input.request.expiresAt ||
    input.response.requestHash.toLowerCase() !== paymentRequestHash(input.request).toLowerCase()
  )
    throw new InvalidQrExchange("Attendee response is expired or targets another request");
  const voucher = decodeOfflineVoucher(input.request.voucher);
  let recovered: `0x${string}`;
  try {
    recovered = await recoverAddress({
      hash: offlineVoucherDigest(voucher),
      signature: input.response.attendeeSignature,
    });
  } catch {
    throw new InvalidQrExchange("Attendee signature is invalid");
  }
  if (getAddress(recovered) !== getAddress(input.attendeeSigner))
    throw new InvalidQrExchange("Attendee signature does not match channel authority");
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
