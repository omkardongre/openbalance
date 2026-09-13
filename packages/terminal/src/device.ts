import {
  canonicalVoucherReceipt,
  decodeOfflineVoucher,
  offlineVoucherDigest,
} from "@openbalance/protocol";
import { type Address, getAddress, type Hex, sha256, stringToHex } from "viem";
import { TerminalClock, type TrustedTimeSample } from "./clock.js";
import type { TerminalJournal, TerminalSale } from "./journal.js";
import { decodeAttendeeResponseQr, encodePaymentRequestQr } from "./qr.js";

export interface ProtectedTerminalKey {
  readonly signer: Address;
  readonly keyVersion: bigint;
  signDigest(digest: Hex): Promise<Hex>;
}

export interface AuthenticatedTimeSource {
  sample(): Promise<TrustedTimeSample>;
}

export interface DeviceMonotonicClock {
  read(): { monotonicMs: number; bootId: string };
}

export interface QrCamera {
  scan(): Promise<string>;
}

export type TerminalDevicePolicy = {
  maximumTimeSampleAgeMs: number;
  maximumTimeUncertaintyMs: number;
  maximumClockDriftPpm: number;
};

export class TerminalDeviceNotReady extends Error {}

/**
 * Installed-host coordinator. Native hosts provide protected keys, authenticated time and camera
 * isolation; this class never accepts those values from a QR payload or cashier form.
 */
export class TerminalDeviceController {
  #clock: TerminalClock | null = null;

  constructor(
    private readonly journal: TerminalJournal,
    private readonly terminalKey: ProtectedTerminalKey,
    private readonly timeSource: AuthenticatedTimeSource,
    private readonly monotonicClock: DeviceMonotonicClock,
    private readonly camera: QrCamera,
    private readonly policy: TerminalDevicePolicy,
  ) {
    if (
      policy.maximumTimeSampleAgeMs < 1_000 ||
      policy.maximumTimeUncertaintyMs < 0 ||
      policy.maximumClockDriftPpm < 0 ||
      terminalKey.keyVersion < 1n ||
      getAddress(terminalKey.signer) === "0x0000000000000000000000000000000000000000"
    )
      throw new Error("Invalid terminal device policy");
  }

  async refreshTrustedTime(): Promise<void> {
    this.#clock = new TerminalClock({
      sample: await this.timeSource.sample(),
      maxAgeMs: this.policy.maximumTimeSampleAgeMs,
      maxUncertaintyMs: this.policy.maximumTimeUncertaintyMs,
      driftPpm: this.policy.maximumClockDriftPpm,
    });
  }

  preparePayment(input: {
    requestId: string;
    channelId: Hex;
    paymentId: Hex;
    orderRefHash: Hex;
    grossUnits: bigint;
    receiptCommitment: Hex;
    expiresAt: number;
  }): { sale: TerminalSale; qr: string } {
    const clock = this.#requiredClock();
    const sale = this.journal.prepareTimedSale(input, clock, this.monotonicClock.read());
    return { sale, qr: encodePaymentRequestQr(sale.request) };
  }

  async scanAndAccept(
    requestId: string,
  ): Promise<{ sale: TerminalSale; receiptQrPayload: string }> {
    const existing = this.journal.getSale(requestId);
    if (existing.receipt)
      return {
        sale: existing,
        receiptQrPayload: canonicalVoucherReceipt(existing.receipt),
      };
    const response = decodeAttendeeResponseQr(await this.camera.scan());
    const reading = this.monotonicClock.read();
    const window = this.#requiredClock().window(reading.monotonicMs, reading.bootId);
    const nowSeconds = Math.ceil(window.latestUnixMs / 1_000);
    const attendeeSigned = await this.journal.recordAttendeeResponse(
      requestId,
      response,
      nowSeconds,
    );
    const voucher = decodeOfflineVoucher(attendeeSigned.request.voucher);
    const terminalSignature = await this.terminalKey.signDigest(offlineVoucherDigest(voucher));
    const accepted = await this.journal.acceptSale(
      requestId,
      `receipt:${sha256(stringToHex(requestId)).slice(2)}`,
      terminalSignature,
    );
    if (!accepted.receipt) throw new TerminalDeviceNotReady("Accepted sale has no receipt");
    return { sale: accepted, receiptQrPayload: canonicalVoucherReceipt(accepted.receipt) };
  }

  #requiredClock(): TerminalClock {
    if (!this.#clock)
      throw new TerminalDeviceNotReady("Refresh authenticated time before accepting sales");
    return this.#clock;
  }
}
