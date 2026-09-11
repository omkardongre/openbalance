import {
  encodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
} from "@openbalance/protocol";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { receiptPayloadHash, type VoucherReceipt } from "../src/journal.js";
import {
  authenticateTerminalReceipt,
  TerminalAuthenticationFailed,
  type TerminalAuthorization,
  type TerminalDirectory,
  terminalIngressDigest,
} from "../src/transport.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const terminal = privateKeyToAccount(hex32("1"));

const voucher: OfflineVoucher = {
  protocolVersion: 1,
  chainId: 10_143n,
  vault: "0x2222222222222222222222222222222222222222",
  channelId: hex32("3"),
  sequence: 1,
  previousVoucherDigest: hex32("4"),
  paymentId: hex32("5"),
  orderRefHash: hex32("6"),
  grossUnits: 100n,
  cumulativeGrossUnits: 100n,
  receiptCommitment: hex32("7"),
  acceptedAt: 100,
  acceptUntil: 200,
  submitUntil: 300,
  configVersion: 1n,
};

async function signedInput() {
  const receipt: VoucherReceipt = {
    receiptId: "receipt:terminal:1",
    terminalId: hex32("8"),
    channelId: voucher.channelId,
    sequence: voucher.sequence,
    paymentId: voucher.paymentId,
    voucher: encodeOfflineVoucher(voucher),
    attendeeSignature: `0x${"aa".repeat(65)}`,
    terminalSignature: await terminal.sign({ hash: offlineVoucherDigest(voucher) }),
  };
  const authorization: TerminalAuthorization = {
    keyVersion: 1n,
    sentAt: 110,
    nonce: hex32("9"),
    signature: await terminal.sign({
      hash: terminalIngressDigest({
        audience: "https://relay.example/v1/vouchers",
        terminalId: receipt.terminalId as `0x${string}`,
        keyVersion: 1n,
        sentAt: 110,
        nonce: hex32("9"),
        payloadHash: `0x${receiptPayloadHash(receipt)}`,
      }),
    }),
  };
  return { receipt, authorization };
}

const directory: TerminalDirectory = {
  resolve: async () => ({
    signer: terminal.address,
    enabled: true,
    validAfter: 50,
    validUntil: 250,
  }),
};

it("authenticates the transport and embedded voucher signatures", async () => {
  const input = await signedInput();
  const authenticated = await authenticateTerminalReceipt({
    ...input,
    audience: "https://relay.example/v1/vouchers",
    directory,
    nowSeconds: 111,
    maximumClockSkewSeconds: 30,
  });
  expect(authenticated.voucher).toEqual(voucher);
  expect(authenticated.payloadHash).toBe(receiptPayloadHash(input.receipt));
});

it("rejects stale requests and receipt metadata tampering", async () => {
  const input = await signedInput();
  await expect(
    authenticateTerminalReceipt({
      ...input,
      audience: "https://relay.example/v1/vouchers",
      directory,
      nowSeconds: 200,
      maximumClockSkewSeconds: 30,
    }),
  ).rejects.toThrow(TerminalAuthenticationFailed);
  await expect(
    authenticateTerminalReceipt({
      ...input,
      receipt: { ...input.receipt, sequence: 2 },
      audience: "https://relay.example/v1/vouchers",
      directory,
      nowSeconds: 111,
      maximumClockSkewSeconds: 30,
    }),
  ).rejects.toThrow(TerminalAuthenticationFailed);
});
