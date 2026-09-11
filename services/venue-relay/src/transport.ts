import {
  decodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
  terminalIngressDigest,
} from "@openbalance/protocol";
import { type Address, getAddress, type Hex, recoverAddress } from "viem";
import { receiptPayloadHash, type VoucherReceipt, validateReceipt } from "./journal.js";

const signature = /^0x[0-9a-fA-F]{130}$/;

export { terminalIngressDigest } from "@openbalance/protocol";

export type TerminalAuthorization = {
  keyVersion: bigint;
  sentAt: number;
  nonce: Hex;
  signature: Hex;
};

export type TerminalRegistration = {
  signer: Address;
  enabled: boolean;
  validAfter: number;
  validUntil: number;
};

export interface TerminalDirectory {
  resolve(input: {
    terminalId: Hex;
    keyVersion: bigint;
    channelId: Hex;
  }): Promise<TerminalRegistration | null>;
}

export class TerminalAuthenticationFailed extends Error {}

export function decodeVoucher(receipt: VoucherReceipt): OfflineVoucher {
  validateReceipt(receipt);
  let voucher: OfflineVoucher;
  try {
    voucher = decodeOfflineVoucher(receipt.voucher as Hex);
  } catch {
    throw new TerminalAuthenticationFailed("Voucher encoding is invalid");
  }
  if (
    voucher.channelId.toLowerCase() !== receipt.channelId.toLowerCase() ||
    voucher.paymentId.toLowerCase() !== receipt.paymentId.toLowerCase() ||
    voucher.sequence !== receipt.sequence
  )
    throw new TerminalAuthenticationFailed("Receipt metadata does not match voucher");
  return voucher;
}

export async function authenticateTerminalReceipt(input: {
  receipt: VoucherReceipt;
  authorization: TerminalAuthorization;
  audience: string;
  directory: TerminalDirectory;
  nowSeconds: number;
  maximumClockSkewSeconds: number;
}): Promise<{ payloadHash: string; voucher: OfflineVoucher }> {
  const { receipt, authorization } = input;
  const voucher = decodeVoucher(receipt);
  if (
    !Number.isSafeInteger(input.nowSeconds) ||
    !Number.isSafeInteger(input.maximumClockSkewSeconds) ||
    input.maximumClockSkewSeconds < 1 ||
    input.maximumClockSkewSeconds > 900 ||
    Math.abs(input.nowSeconds - authorization.sentAt) > input.maximumClockSkewSeconds ||
    !signature.test(authorization.signature)
  )
    throw new TerminalAuthenticationFailed("Terminal authorization is expired or invalid");

  const registration = await input.directory.resolve({
    terminalId: receipt.terminalId as Hex,
    keyVersion: authorization.keyVersion,
    channelId: receipt.channelId as Hex,
  });
  if (
    !registration?.enabled ||
    authorization.sentAt < registration.validAfter ||
    authorization.sentAt >= registration.validUntil
  )
    throw new TerminalAuthenticationFailed("Terminal is unavailable");

  const payloadHash = receiptPayloadHash(receipt);
  const digest = terminalIngressDigest({
    audience: input.audience,
    terminalId: receipt.terminalId as Hex,
    keyVersion: authorization.keyVersion,
    sentAt: authorization.sentAt,
    nonce: authorization.nonce,
    payloadHash: `0x${payloadHash}`,
  });
  let transportSigner: Address;
  let voucherSigner: Address;
  try {
    [transportSigner, voucherSigner] = await Promise.all([
      recoverAddress({ hash: digest, signature: authorization.signature }),
      recoverAddress({
        hash: offlineVoucherDigest(voucher),
        signature: receipt.terminalSignature as Hex,
      }),
    ]);
  } catch {
    throw new TerminalAuthenticationFailed("Terminal signature is invalid");
  }
  const expected = getAddress(registration.signer);
  if (getAddress(transportSigner) !== expected || getAddress(voucherSigner) !== expected)
    throw new TerminalAuthenticationFailed("Terminal signature does not match enrollment");
  return { payloadHash, voucher };
}
