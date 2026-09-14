import { bytesToString, type Hex, keccak256, stringToBytes, stringToHex } from "viem";
import { decodeOfflineVoucher } from "./payments.js";

const PREFIX = "obqr1:";
const MAX_QR_LENGTH = 4_096;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const COMPACT_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class InvalidOfflineExchange extends Error {}

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

function validateRequest(request: TerminalPaymentRequest): void {
  if (
    request.version !== 1 ||
    request.kind !== "offline-payment-request" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(request.requestId) ||
    !HEX_32.test(request.terminalId) ||
    !HEX_32.test(request.channelId) ||
    !HEX_32.test(request.paymentId) ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 1 ||
    request.sequence >= 2 ** 32 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(request.voucher) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt < 0
  )
    throw new InvalidOfflineExchange("Invalid terminal payment request");

  const voucher = decodeOfflineVoucher(request.voucher);
  if (
    voucher.channelId.toLowerCase() !== request.channelId.toLowerCase() ||
    voucher.paymentId.toLowerCase() !== request.paymentId.toLowerCase() ||
    voucher.sequence !== request.sequence ||
    request.expiresAt > voucher.acceptUntil ||
    request.expiresAt < voucher.acceptedAt
  )
    throw new InvalidOfflineExchange("Payment request does not match voucher");
}

function validateResponse(response: AttendeeVoucherResponse): void {
  if (
    response.version !== 1 ||
    response.kind !== "offline-voucher-response" ||
    !HEX_32.test(response.requestHash) ||
    !COMPACT_SIGNATURE.test(response.attendeeSignature)
  )
    throw new InvalidOfflineExchange("Invalid attendee voucher response");
}

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

function encodeBase64Url(value: string): string {
  const bytes = stringToBytes(value);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL.charAt(first >> 2);
    encoded += BASE64URL.charAt(((first & 3) << 4) | ((second ?? 0) >> 4));
    if (second !== undefined)
      encoded += BASE64URL.charAt(((second & 15) << 2) | ((third ?? 0) >> 6));
    if (third !== undefined) encoded += BASE64URL.charAt(third & 63);
  }
  return encoded;
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("Invalid base64url");
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64URL.indexOf(value[index] ?? "");
    const b = BASE64URL.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === undefined ? -1 : BASE64URL.indexOf(value[index + 2] ?? "");
    const d = value[index + 3] === undefined ? -1 : BASE64URL.indexOf(value[index + 3] ?? "");
    if (a < 0 || b < 0 || c < -1 || d < -1) throw new Error("Invalid base64url");
    output.push((a << 2) | (b >> 4));
    if (c >= 0) output.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) output.push(((c & 3) << 6) | d);
  }
  return bytesToString(Uint8Array.from(output));
}

function encodeQr(canonical: string): string {
  const encoded = `${PREFIX}${encodeBase64Url(canonical)}`;
  if (encoded.length > MAX_QR_LENGTH)
    throw new InvalidOfflineExchange("QR payload exceeds supported size");
  return encoded;
}

function decodeQr(value: string): unknown {
  if (!value.startsWith(PREFIX) || value.length > MAX_QR_LENGTH)
    throw new InvalidOfflineExchange("Invalid QR envelope");
  try {
    const payload = value.slice(PREFIX.length);
    const json = decodeBase64Url(payload);
    if (encodeBase64Url(json) !== payload) throw new Error("Noncanonical base64url");
    return JSON.parse(json);
  } catch {
    throw new InvalidOfflineExchange("Invalid QR encoding");
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
    throw new InvalidOfflineExchange("Invalid terminal payment request");
  const request = decoded as TerminalPaymentRequest;
  validateRequest(request);
  if (canonicalRequest(request) !== JSON.stringify(request))
    throw new InvalidOfflineExchange("QR request is not canonical");
  return request;
}

export function encodeAttendeeResponseQr(response: AttendeeVoucherResponse): string {
  return encodeQr(canonicalResponse(response));
}

export function decodeAttendeeResponseQr(value: string): AttendeeVoucherResponse {
  const decoded = decodeQr(value);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new InvalidOfflineExchange("Invalid attendee voucher response");
  const response = decoded as AttendeeVoucherResponse;
  validateResponse(response);
  if (canonicalResponse(response) !== JSON.stringify(response))
    throw new InvalidOfflineExchange("QR response is not canonical");
  return response;
}
