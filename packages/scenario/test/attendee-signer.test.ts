import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttendeeChannelState } from "@openbalance/attendee";
import {
  canonicalVoucherReceipt,
  decodeAttendeeResponseQr,
  encodeOfflineVoucher,
  encodePaymentRequestQr,
  offlineVoucherDigest,
  paymentRequestHash,
} from "@openbalance/protocol";
import QRCode from "qrcode";
import { getAddress, type Hex, keccak256, recoverAddress, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { channelSignerFor, decodeQrPng, runAttendeeSigner } from "../src/attendee-signer.js";

const runId = "attendee-test";
const b32 = (label: string) => keccak256(stringToHex(label));
const terminal = privateKeyToAccount(b32("terminal"));
const vault = getAddress("0x2222222222222222222222222222222222222222");
const channelId = b32(`channel:${runId}`);
const state = createAttendeeChannelState({
  keyId: `channel-signer:${runId}`,
  signer: channelSignerFor(runId).address,
  chainId: 10_143n,
  vault,
  terminalSigner: terminal.address,
  config: {
    channelId,
    eventId: b32("event"),
    asset: getAddress("0x5555555555555555555555555555555555555555"),
    reserveUnits: 2_000_000n,
    vendorId: b32("vendor"),
    vendorDestinationVersion: 1n,
    terminalInstanceId: b32("terminal-id"),
    terminalKeyVersion: 1n,
    attendeeChannelSigner: channelSignerFor(runId).address,
    configVersion: 1n,
    organizerFeeBps: 200,
    platformFeeBps: 100,
    maxPerVoucher: 1_000_000n,
    maxVoucherCount: 10,
    acceptFrom: 100,
    acceptUntil: 1_000,
    submitUntil: 2_000,
    genesisDigest: b32("genesis"),
  },
  display: { vendorName: "Merch", assetSymbol: "USDC", assetDecimals: 6 },
});
const voucher = {
  protocolVersion: 1,
  chainId: 10_143n,
  vault,
  channelId,
  sequence: 1,
  previousVoucherDigest: b32("genesis"),
  paymentId: b32("payment"),
  orderRefHash: b32("order"),
  grossUnits: 1_000_000n,
  cumulativeGrossUnits: 1_000_000n,
  receiptCommitment: b32("receipt"),
  acceptedAt: 200,
  acceptUntil: 1_000,
  submitUntil: 2_000,
  configVersion: 1n,
};
const request = {
  version: 1 as const,
  kind: "offline-payment-request" as const,
  requestId: "sale:1",
  terminalId: b32("terminal-id"),
  channelId,
  paymentId: voucher.paymentId,
  sequence: 1,
  voucher: encodeOfflineVoucher(voucher),
  expiresAt: 320,
};

// QR rendering and decoding dominate; a loaded CI host can take longer than the default budget.
describe("attendee signer", { timeout: 20_000 }, () => {
  it("approves a scanned request once and stores the matching terminal receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attendee-"));
    const walletPath = join(dir, "wallet.json");
    await writeFile(
      walletPath,
      JSON.stringify({ schemaVersion: 1, runId, state, authorizations: [] }, (_k, v) =>
        typeof v === "bigint" ? { $bigint: v.toString() } : v,
      ),
    );
    const requestPng = join(dir, "request.png");
    await QRCode.toFile(requestPng, encodePaymentRequestQr(request), { width: 600 });
    const options = {
      rpcUrl: "http://unused",
      walletPath,
      runId,
      vault,
      registry: vault,
      vendorName: "Merch",
      input: requestPng,
      responsePngPath: join(dir, "response.png"),
      nowSeconds: 300,
    };

    const first = await runAttendeeSigner(options);
    if (first.kind !== "attendee-authorized") throw new Error("expected authorization");
    const response = decodeAttendeeResponseQr(decodeQrPng(await readFile(options.responsePngPath)));
    const digest = offlineVoucherDigest(voucher);
    expect(response.requestHash).toBe(paymentRequestHash(request));
    expect(await recoverAddress({ hash: digest, signature: response.attendeeSignature })).toBe(
      state.signer,
    );
    expect(first.remainingUnits).toBe("1000000");

    // A rescan returns the stored answer instead of signing the sequence a second time.
    const again = await runAttendeeSigner(options);
    expect(again.kind === "attendee-authorized" && again.responseQr).toBe(first.responseQr);

    const receipt = canonicalVoucherReceipt({
      receiptId: "receipt:1",
      terminalId: request.terminalId,
      channelId,
      sequence: 1,
      paymentId: request.paymentId,
      voucher: request.voucher,
      attendeeSignature: response.attendeeSignature,
      terminalSignature: (await terminal.sign({ hash: digest })) as Hex,
    });
    await expect(runAttendeeSigner({ ...options, input: receipt })).resolves.toMatchObject({
      kind: "attendee-receipt-stored",
      sequence: 1,
    });
    const forged = receipt.replace(
      /"terminalSignature":"0x[0-9a-f]{2}/,
      '"terminalSignature":"0x00',
    );
    await expect(runAttendeeSigner({ ...options, input: forged })).rejects.toThrow();
  });

  it("re-signs a sequence the terminal re-requested after the first answer expired unconfirmed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attendee-"));
    const walletPath = join(dir, "wallet.json");
    await writeFile(
      walletPath,
      JSON.stringify({ schemaVersion: 1, runId, state, authorizations: [] }, (_k, v) =>
        typeof v === "bigint" ? { $bigint: v.toString() } : v,
      ),
    );
    const options = {
      rpcUrl: "http://unused",
      walletPath,
      runId,
      vault,
      registry: vault,
      vendorName: "Merch",
      input: encodePaymentRequestQr(request),
      responsePngPath: join(dir, "response.png"),
      nowSeconds: 300,
    };
    await runAttendeeSigner(options);

    const replacement = { ...voucher, paymentId: b32("payment:2"), acceptedAt: 330 };
    const reissued = {
      ...request,
      requestId: "sale:2",
      paymentId: replacement.paymentId,
      voucher: encodeOfflineVoucher(replacement),
      expiresAt: 450,
    };
    const input = encodePaymentRequestQr(reissued);
    // Still live: the first answer may yet be confirmed, so the sequence is not re-signed.
    await expect(runAttendeeSigner({ ...options, input, nowSeconds: 310 })).rejects.toThrow();
    const second = await runAttendeeSigner({ ...options, input, nowSeconds: 340 });
    expect(second).toMatchObject({ kind: "attendee-authorized", sequence: 1 });

    const wallet = JSON.parse(await readFile(walletPath, "utf8"));
    expect(wallet.authorizations[0].supersededBy).toBe(replacement.paymentId);
    expect(wallet.state.nextSequence).toBe(2);
    const response = decodeAttendeeResponseQr(
      second.kind === "attendee-authorized" ? second.responseQr : "",
    );
    const staleReceipt = canonicalVoucherReceipt({
      receiptId: "receipt:1",
      terminalId: request.terminalId,
      channelId,
      sequence: 1,
      paymentId: request.paymentId,
      voucher: request.voucher,
      attendeeSignature: response.attendeeSignature,
      terminalSignature: (await terminal.sign({ hash: offlineVoucherDigest(voucher) })) as Hex,
    });
    await expect(runAttendeeSigner({ ...options, input: staleReceipt })).rejects.toThrow(
      /replaced/,
    );
  });
});
