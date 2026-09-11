import { encodeAbiParameters, type Hex, keccak256, sha256, stringToHex } from "viem";

export type VoucherReceipt = {
  receiptId: string;
  terminalId: Hex;
  channelId: Hex;
  sequence: number;
  paymentId: Hex;
  voucher: Hex;
  attendeeSignature: Hex;
  terminalSignature: Hex;
};

const hex32 = /^0x[0-9a-fA-F]{64}$/;
const hexBytes = /^0x(?:[0-9a-fA-F]{2})+$/;
const compactSignature = /^0x[0-9a-fA-F]{130}$/;
const terminalRequestTypeHash = keccak256(
  stringToHex(
    "OpenBalanceTerminalIngress(bytes32 audienceHash,bytes32 terminalId,uint256 keyVersion,uint64 sentAt,bytes32 nonce,bytes32 payloadHash)",
  ),
);

export function validateVoucherReceipt(receipt: VoucherReceipt): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(receipt.receiptId) ||
    !hex32.test(receipt.terminalId) ||
    !hex32.test(receipt.channelId) ||
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence <= 0 ||
    receipt.sequence >= 2 ** 32 ||
    !hex32.test(receipt.paymentId) ||
    !hexBytes.test(receipt.voucher) ||
    !compactSignature.test(receipt.attendeeSignature) ||
    !compactSignature.test(receipt.terminalSignature)
  )
    throw new Error("Invalid voucher receipt");
}

export function canonicalVoucherReceipt(receipt: VoucherReceipt): string {
  validateVoucherReceipt(receipt);
  return JSON.stringify({
    receiptId: receipt.receiptId,
    terminalId: receipt.terminalId.toLowerCase(),
    channelId: receipt.channelId.toLowerCase(),
    sequence: receipt.sequence,
    paymentId: receipt.paymentId.toLowerCase(),
    voucher: receipt.voucher.toLowerCase(),
    attendeeSignature: receipt.attendeeSignature.toLowerCase(),
    terminalSignature: receipt.terminalSignature.toLowerCase(),
  });
}

export function voucherReceiptPayloadHash(receipt: VoucherReceipt): string {
  return sha256(stringToHex(canonicalVoucherReceipt(receipt))).slice(2);
}

export function terminalIngressDigest(input: {
  audience: string;
  terminalId: Hex;
  keyVersion: bigint;
  sentAt: number;
  nonce: Hex;
  payloadHash: Hex;
}): Hex {
  if (
    input.audience.length < 1 ||
    input.audience.length > 512 ||
    !hex32.test(input.terminalId) ||
    input.keyVersion <= 0n ||
    !Number.isSafeInteger(input.sentAt) ||
    input.sentAt < 0 ||
    !hex32.test(input.nonce) ||
    !hex32.test(input.payloadHash)
  )
    throw new Error("Terminal authorization is invalid");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        terminalRequestTypeHash,
        keccak256(stringToHex(input.audience)),
        input.terminalId,
        input.keyVersion,
        BigInt(input.sentAt),
        input.nonce,
        input.payloadHash,
      ],
    ),
  );
}
