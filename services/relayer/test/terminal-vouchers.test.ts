import {
  canonicalVoucherReceipt,
  encodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
  resilienceVaultAbi,
  terminalIngressDigest,
  type VoucherReceipt,
  voucherReceiptPayloadHash,
} from "@openbalance/protocol";
import { decodeFunctionData, keccak256, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, it, vi } from "vitest";
import type { AcceptFinancialOperation, FinancialOperation } from "../src/financial-operations.js";
import {
  TerminalIngressRejected,
  TerminalVoucherIngressService,
} from "../src/terminal-vouchers.js";
import { VendorCommandRejected } from "../src/vendor-commands.js";
import { type FinalizedChannel, VoucherChannelNotFound } from "../src/vendor-vouchers.js";

const eventId = keccak256(stringToHex("terminal-event"));
const vendorId = keccak256(stringToHex("terminal-vendor"));
const channelId = keccak256(stringToHex("terminal-channel"));
const terminalId = keccak256(stringToHex("terminal-instance"));
const vault = "0x0000000000000000000000000000000000000606";
const audience = "https://relayer.example/v1/vouchers";
const nowSeconds = 1_800_000_000;
const terminal = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const voucher: OfflineVoucher = {
  protocolVersion: 1,
  chainId: 10_143n,
  vault,
  channelId,
  sequence: 1,
  previousVoucherDigest: keccak256(stringToHex("genesis")),
  paymentId: keccak256(stringToHex("terminal-payment")),
  orderRefHash: keccak256(stringToHex("order")),
  grossUnits: 1_000_000n,
  cumulativeGrossUnits: 1_000_000n,
  receiptCommitment: keccak256(stringToHex("receipt")),
  acceptedAt: nowSeconds - 60,
  acceptUntil: nowSeconds + 600,
  submitUntil: nowSeconds + 900,
  configVersion: 1n,
};
const channel: FinalizedChannel = {
  vendorId,
  nextSequence: 1,
  submitUntil: BigInt(voucher.submitUntil),
  reclaimed: false,
};

async function signedUpload(signer = terminal, sentAt = nowSeconds) {
  const receipt: VoucherReceipt = {
    receiptId: "receipt:terminal-test",
    terminalId,
    channelId,
    sequence: 1,
    paymentId: voucher.paymentId,
    voucher: encodeOfflineVoucher(voucher),
    attendeeSignature: `0x${"11".repeat(65)}`,
    terminalSignature: await signer.sign({ hash: offlineVoucherDigest(voucher) }),
  };
  canonicalVoucherReceipt(receipt);
  const nonce = keccak256(stringToHex(`nonce:${sentAt}`));
  const authorization = {
    keyVersion: 1n,
    sentAt,
    nonce,
    signature: await signer.sign({
      hash: terminalIngressDigest({
        audience,
        terminalId,
        keyVersion: 1n,
        sentAt,
        nonce,
        payloadHash: `0x${voucherReceiptPayloadHash(receipt)}`,
      }),
    }),
  };
  return { receipt, authorization };
}

function build(
  options: { prior?: Partial<FinancialOperation>; channel?: FinalizedChannel | undefined } = {},
) {
  const accept = vi.fn(async (input: AcceptFinancialOperation) => ({
    created: true,
    operation: {
      ...input,
      operationId: "00000000-0000-4000-8000-000000000007",
      state: "ACCEPTED",
      transaction: null,
    } as unknown as FinancialOperation,
  }));
  const findByIdempotency = vi.fn(async () =>
    options.prior
      ? ({ state: "ACCEPTED", transaction: null, ...options.prior } as FinancialOperation)
      : null,
  );
  const service = new TerminalVoucherIngressService({
    journal: { accept, findByIdempotency },
    manifest: {
      schemaVersion: 1,
      chainId: 10_143,
      events: [
        {
          eventId,
          router: "0x0000000000000000000000000000000000000101",
          vault,
          ledger: "0x0000000000000000000000000000000000000707",
          asset: "0x0000000000000000000000000000000000000303",
          deploymentBlock: 1n,
        },
      ],
    },
    channel: async () => ("channel" in options ? options.channel : channel),
    terminal: async () => ({
      terminalInstanceId: terminalId,
      terminalKeyVersion: 1n,
      signer: terminal.address,
    }),
    chainSeconds: async () => BigInt(nowSeconds),
    audience,
    now: () => nowSeconds * 1_000,
  });
  return { service, accept, findByIdempotency };
}

it("journals a voucher signed by the channel's own terminal, keyed by payment", async () => {
  const { service, accept } = build();
  const result = await service.accept(await signedUpload());
  expect(result).toEqual({
    receiptId: "receipt:terminal-test",
    state: "PENDING",
    transactionHash: null,
    duplicate: false,
  });
  const input = accept.mock.calls[0]?.[0];
  expect(input).toMatchObject({
    actorId: `terminal:${terminalId}`,
    kind: "VOUCHER_SETTLE",
    idempotencyKey: `voucher:${voucher.paymentId}`,
    targetAddress: vault,
    expiresAt: new Date(voucher.submitUntil * 1_000),
  });
  expect(
    decodeFunctionData({ abi: resilienceVaultAbi, data: input?.calldata ?? "0x" }).functionName,
  ).toBe("settleVoucher");
});

it("reports a finalized upload as settled with its transaction on every later poll", async () => {
  const hash = keccak256(stringToHex("tx"));
  const { service, accept } = build({
    prior: { state: "FINALIZED", transaction: { hash } as FinancialOperation["transaction"] },
    channel: { ...channel, nextSequence: 2 },
  });
  const result = await service.accept(await signedUpload());
  expect(result).toMatchObject({ state: "SETTLED", transactionHash: hash, duplicate: true });
  expect(accept).not.toHaveBeenCalled();
});

it("rejects a request not signed by the channel's terminal", async () => {
  const { service, accept } = build();
  await expect(service.accept(await signedUpload(stranger))).rejects.toBeInstanceOf(
    TerminalIngressRejected,
  );
  expect(accept).not.toHaveBeenCalled();
});

it("rejects a stale authorization", async () => {
  const { service } = build();
  await expect(
    service.accept(await signedUpload(terminal, nowSeconds - 600)),
  ).rejects.toBeInstanceOf(TerminalIngressRejected);
});

it("waits for a channel the indexer has not projected yet", async () => {
  const { service } = build({ channel: undefined });
  await expect(service.accept(await signedUpload())).rejects.toBeInstanceOf(VoucherChannelNotFound);
});

it("does not sponsor a voucher the channel has moved past", async () => {
  const { service } = build({ channel: { ...channel, nextSequence: 2 } });
  await expect(service.accept(await signedUpload())).rejects.toBeInstanceOf(VendorCommandRejected);
});
