import type { Hex } from "viem";
import type { JournalRecord, VenueRelayJournal, VoucherReceipt } from "./journal.js";

export type SettlementObservation =
  | { status: "ABSENT" }
  | { status: "PENDING"; transactionHash: Hex }
  | { status: "SETTLED"; transactionHash: Hex }
  | { status: "REJECTED"; transactionHash: Hex | null; reason: string };

export interface VoucherSettlementGateway {
  reconcile(receipt: VoucherReceipt, transactionHash: Hex | null): Promise<SettlementObservation>;
  submit(receipt: VoucherReceipt): Promise<{ transactionHash: Hex }>;
}

export class PermanentSettlementFailure extends Error {}

export type SettlementOutcome = {
  receiptId: string;
  state: "SUBMITTED" | "SETTLED" | "RETRY" | "QUARANTINED" | "WAITING";
  transactionHash: string | null;
};

export type SettlementProcessorOptions = {
  owner: string;
  leaseMilliseconds?: number;
  pollMilliseconds?: number;
  maximumBackoffMilliseconds?: number;
};

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500) || error.name;
  return "Settlement operation failed";
}

export class VoucherSettlementProcessor {
  readonly #journal: VenueRelayJournal;
  readonly #gateway: VoucherSettlementGateway;
  readonly #owner: string;
  readonly #leaseMilliseconds: number;
  readonly #pollMilliseconds: number;
  readonly #maximumBackoffMilliseconds: number;

  constructor(
    journal: VenueRelayJournal,
    gateway: VoucherSettlementGateway,
    options: SettlementProcessorOptions,
  ) {
    if (
      !/^[A-Za-z0-9:_-]{1,128}$/.test(options.owner) ||
      (options.leaseMilliseconds ?? 30_000) < 1_000 ||
      (options.pollMilliseconds ?? 5_000) < 1_000 ||
      (options.maximumBackoffMilliseconds ?? 300_000) < (options.pollMilliseconds ?? 5_000)
    )
      throw new Error("Invalid settlement processor configuration");
    this.#journal = journal;
    this.#gateway = gateway;
    this.#owner = options.owner;
    this.#leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
    this.#pollMilliseconds = options.pollMilliseconds ?? 5_000;
    this.#maximumBackoffMilliseconds = options.maximumBackoffMilliseconds ?? 300_000;
  }

  async runBatch(limit: number, now = Date.now()): Promise<SettlementOutcome[]> {
    const records = this.#journal.leaseReady(limit, this.#owner, now, this.#leaseMilliseconds);
    const outcomes: SettlementOutcome[] = [];
    for (const record of records) outcomes.push(await this.#process(record, now));
    return outcomes;
  }

  async #process(record: JournalRecord, now: number): Promise<SettlementOutcome> {
    try {
      const observed = await this.#gateway.reconcile(
        record.receipt,
        record.transactionHash as Hex | null,
      );
      if (observed.status === "SETTLED") {
        const settled = this.#journal.markSettled(record.receiptId, observed.transactionHash, now);
        return this.#outcome(settled, "SETTLED");
      }
      if (observed.status === "REJECTED") {
        const quarantined = this.#journal.quarantine(
          record.receiptId,
          this.#owner,
          observed.reason,
          now,
        );
        return this.#outcome(quarantined, "QUARANTINED");
      }
      if (record.state === "SUBMITTED") {
        const waiting = this.#journal.deferSubmitted(
          record.receiptId,
          this.#owner,
          now + this.#pollMilliseconds,
          now,
        );
        return this.#outcome(waiting, "WAITING");
      }
      if (observed.status === "PENDING") {
        const submitted = this.#journal.markSubmitted(
          record.receiptId,
          this.#owner,
          observed.transactionHash,
          now,
        );
        return this.#outcome(submitted, "SUBMITTED");
      }
      const submitted = await this.#gateway.submit(record.receipt);
      const saved = this.#journal.markSubmitted(
        record.receiptId,
        this.#owner,
        submitted.transactionHash,
        now,
      );
      return this.#outcome(saved, "SUBMITTED");
    } catch (error) {
      if (error instanceof PermanentSettlementFailure) {
        const quarantined = this.#journal.quarantine(
          record.receiptId,
          this.#owner,
          safeError(error),
          now,
        );
        return this.#outcome(quarantined, "QUARANTINED");
      }
      if (record.state === "SUBMITTED") {
        const waiting = this.#journal.deferSubmitted(
          record.receiptId,
          this.#owner,
          now + this.#pollMilliseconds,
          now,
        );
        return this.#outcome(waiting, "WAITING");
      }
      const exponent = Math.min(record.attempts, 20);
      const delay = Math.min(
        this.#pollMilliseconds * 2 ** exponent,
        this.#maximumBackoffMilliseconds,
      );
      const retry = this.#journal.retry(
        record.receiptId,
        this.#owner,
        now + delay,
        safeError(error),
        now,
      );
      return this.#outcome(retry, "RETRY");
    }
  }

  #outcome(record: JournalRecord, state: SettlementOutcome["state"]): SettlementOutcome {
    return {
      receiptId: record.receiptId,
      state,
      transactionHash: record.transactionHash,
    };
  }
}
