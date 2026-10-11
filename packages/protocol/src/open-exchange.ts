import { bytesToString, type Hex, keccak256, stringToBytes, stringToHex } from "viem";
import { InvalidOfflineExchange } from "./offline-exchange.js";
import type { OfflineVoucher } from "./payments.js";

/**
 * Version 2 of the offline QR exchange: the cashier charges an amount, and the customer's phone
 * picks which of its reserves for this stall pays.
 *
 * Version 1 put a whole voucher, already bound to one reserve, in the request, so the cashier had
 * to choose the customer's reserve before charging. Here the request carries only what the stall
 * decides (amount, order commitments, payment id, time) plus the terminal's own position on each
 * reserve it can charge. The phone builds the voucher from its reserve and that position, signs
 * it, and answers with the reserve it chose. The terminal rebuilds the same voucher from its own
 * records before countersigning, so nothing the phone sends about the reserve is trusted.
 *
 * The voucher, its digest and the receipt are unchanged, so settlement on chain is unaffected.
 */

const PREFIX = "obqr1:";
const MAX_QR_LENGTH = 4_096;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const COMPACT_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const UNITS = /^[1-9][0-9]{0,77}$/;
const CURSOR = /^([0-9a-f]{12}):([1-9][0-9]{0,9})$/;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Most reserves one request lists; keeps the QR comfortably scannable. */
export const MAX_REQUEST_CURSORS = 48;

/**
 * A charge the customer's phone can pay from any of its reserves for this terminal.
 * `cursors` lists, for each reserve the terminal can charge right now, the first 6 bytes of the
 * reserve id and the sequence the terminal expects next on it ("abcdef012345:3"), sorted.
 */
export type OpenPaymentRequest = {
  version: 2;
  kind: "offline-payment-request";
  requestId: string;
  terminalId: Hex;
  paymentId: Hex;
  orderRefHash: Hex;
  receiptCommitment: Hex;
  grossUnits: string;
  acceptedAt: number;
  expiresAt: number;
  cursors: string[];
};

/** The phone's answer: the reserve it paid from and its signature over the voucher it built. */
export type ChannelVoucherResponse = {
  version: 2;
  kind: "offline-voucher-response";
  requestHash: Hex;
  channelId: Hex;
  attendeeSignature: Hex;
};

/** Key a reserve is listed under in a request: its id's first 6 bytes, lowercase hex. */
export function cursorKey(channelId: Hex): string {
  if (!HEX_32.test(channelId)) throw new InvalidOfflineExchange("Invalid channel ID");
  return channelId.slice(2, 14).toLowerCase();
}

/** The sequence the terminal expects next on this reserve, or undefined when it is not listed. */
export function requestCursor(request: OpenPaymentRequest, channelId: Hex): number | undefined {
  const key = cursorKey(channelId);
  for (const entry of request.cursors) {
    const match = CURSOR.exec(entry);
    if (match?.[1] === key) return Number(match[2]);
  }
  return undefined;
}

function validateRequest(request: OpenPaymentRequest): void {
  if (
    request.version !== 2 ||
    request.kind !== "offline-payment-request" ||
    typeof request.requestId !== "string" ||
    !REQUEST_ID.test(request.requestId) ||
    !HEX_32.test(request.terminalId) ||
    !HEX_32.test(request.paymentId) ||
    !HEX_32.test(request.orderRefHash) ||
    !HEX_32.test(request.receiptCommitment) ||
    typeof request.grossUnits !== "string" ||
    !UNITS.test(request.grossUnits) ||
    !Number.isSafeInteger(request.acceptedAt) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.acceptedAt < 0 ||
    request.expiresAt < request.acceptedAt ||
    !Array.isArray(request.cursors) ||
    request.cursors.length < 1 ||
    request.cursors.length > MAX_REQUEST_CURSORS
  )
    throw new InvalidOfflineExchange("Invalid terminal payment request");
  let previous = "";
  for (const entry of request.cursors) {
    const match = typeof entry === "string" ? CURSOR.exec(entry) : null;
    if (!match || Number(match[2]) >= 2 ** 32 || (match[1] ?? "") <= previous)
      throw new InvalidOfflineExchange("Invalid terminal payment request");
    previous = match[1] ?? "";
  }
}

function validateResponse(response: ChannelVoucherResponse): void {
  if (
    response.version !== 2 ||
    response.kind !== "offline-voucher-response" ||
    !HEX_32.test(response.requestHash) ||
    !HEX_32.test(response.channelId) ||
    !COMPACT_SIGNATURE.test(response.attendeeSignature)
  )
    throw new InvalidOfflineExchange("Invalid attendee voucher response");
}

// Key order and lowercase hex are part of the wire format: the terminal (Kotlin) hashes the same
// bytes, so both sides must produce identical canonical JSON.
function canonicalRequest(request: OpenPaymentRequest): string {
  validateRequest(request);
  return JSON.stringify({
    version: 2,
    kind: "offline-payment-request",
    requestId: request.requestId,
    terminalId: request.terminalId.toLowerCase(),
    paymentId: request.paymentId.toLowerCase(),
    orderRefHash: request.orderRefHash.toLowerCase(),
    receiptCommitment: request.receiptCommitment.toLowerCase(),
    grossUnits: request.grossUnits,
    acceptedAt: request.acceptedAt,
    expiresAt: request.expiresAt,
    cursors: request.cursors,
  });
}

function canonicalResponse(response: ChannelVoucherResponse): string {
  validateResponse(response);
  return JSON.stringify({
    version: 2,
    kind: "offline-voucher-response",
    requestHash: response.requestHash.toLowerCase(),
    channelId: response.channelId.toLowerCase(),
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

function decodeQr(value: string): Record<string, unknown> {
  if (!value.startsWith(PREFIX) || value.length > MAX_QR_LENGTH)
    throw new InvalidOfflineExchange("Invalid QR envelope");
  let decoded: unknown;
  try {
    const payload = value.slice(PREFIX.length);
    const json = decodeBase64Url(payload);
    if (encodeBase64Url(json) !== payload) throw new Error("Noncanonical base64url");
    decoded = JSON.parse(json);
  } catch {
    throw new InvalidOfflineExchange("Invalid QR encoding");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new InvalidOfflineExchange("Invalid QR payload");
  return decoded as Record<string, unknown>;
}

/** True when a scanned payment code is a version 2 (customer picks the reserve) request. */
export function isOpenPaymentRequestQr(value: string): boolean {
  try {
    return decodeQr(value).version === 2;
  } catch {
    return false;
  }
}

export function openRequestHash(request: OpenPaymentRequest): Hex {
  return keccak256(stringToHex(canonicalRequest(request)));
}

export function encodeOpenPaymentRequestQr(request: OpenPaymentRequest): string {
  return encodeQr(canonicalRequest(request));
}

export function decodeOpenPaymentRequestQr(value: string): OpenPaymentRequest {
  const decoded = decodeQr(value) as OpenPaymentRequest;
  validateRequest(decoded);
  if (canonicalRequest(decoded) !== JSON.stringify(decoded))
    throw new InvalidOfflineExchange("QR request is not canonical");
  return decoded;
}

export function encodeChannelResponseQr(response: ChannelVoucherResponse): string {
  return encodeQr(canonicalResponse(response));
}

export function decodeChannelResponseQr(value: string): ChannelVoucherResponse {
  const decoded = decodeQr(value) as ChannelVoucherResponse;
  validateResponse(decoded);
  if (canonicalResponse(decoded) !== JSON.stringify(decoded))
    throw new InvalidOfflineExchange("QR response is not canonical");
  return decoded;
}

/**
 * The voucher both sides sign for a request paid from one reserve. Fields fixed by the reserve
 * come from the reserve; the sequence, previous digest and spent total are the caller's position
 * on it, which the terminal and the phone must agree on or the signatures will not match.
 */
export function voucherForOpenRequest(input: {
  request: OpenPaymentRequest;
  reserve: {
    chainId: bigint;
    vault: OfflineVoucher["vault"];
    channelId: Hex;
    acceptUntil: number;
    submitUntil: number;
    configVersion: bigint;
  };
  sequence: number;
  previousVoucherDigest: Hex;
  spentUnits: bigint;
}): OfflineVoucher {
  const gross = BigInt(input.request.grossUnits);
  return {
    protocolVersion: 1,
    chainId: input.reserve.chainId,
    vault: input.reserve.vault,
    channelId: input.reserve.channelId,
    sequence: input.sequence,
    previousVoucherDigest: input.previousVoucherDigest,
    paymentId: input.request.paymentId,
    orderRefHash: input.request.orderRefHash,
    grossUnits: gross,
    cumulativeGrossUnits: input.spentUnits + gross,
    receiptCommitment: input.request.receiptCommitment,
    acceptedAt: input.request.acceptedAt,
    acceptUntil: input.reserve.acceptUntil,
    submitUntil: input.reserve.submitUntil,
    configVersion: input.reserve.configVersion,
  };
}
