import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalVoucherReceipt,
  type VoucherReceipt,
  validateVoucherReceipt,
  voucherReceiptPayloadHash,
} from "@openbalance/protocol";

export type { VoucherReceipt } from "@openbalance/protocol";

export type ReceiptState = "PENDING" | "RETRY" | "SUBMITTED" | "SETTLED" | "QUARANTINED";

export type JournalRecord = {
  receiptId: string;
  terminalId: string;
  channelId: string;
  sequence: number;
  paymentId: string;
  state: ReceiptState;
  attempts: number;
  nextAttemptAt: number;
  transactionHash: string | null;
  lastError: string | null;
  receipt: VoucherReceipt;
};

export class ReceiptConflict extends Error {}
export class InvalidReceipt extends Error {}
export class InvalidTransition extends Error {}

const hex32 = /^0x[0-9a-fA-F]{64}$/;
const states = new Set<ReceiptState>(["PENDING", "RETRY", "SUBMITTED", "SETTLED", "QUARANTINED"]);

export function canonicalReceipt(receipt: VoucherReceipt): string {
  return canonicalVoucherReceipt(receipt);
}

export function validateReceipt(receipt: VoucherReceipt): void {
  try {
    validateVoucherReceipt(receipt);
  } catch {
    throw new InvalidReceipt("Invalid voucher receipt");
  }
}

export function receiptPayloadHash(receipt: VoucherReceipt): string {
  try {
    return voucherReceiptPayloadHash(receipt);
  } catch {
    throw new InvalidReceipt("Invalid voucher receipt");
  }
}

export type AuthenticatedIngress = {
  nonce: string;
  payloadHash: string;
  authenticatedAt: number;
};

function encrypt(
  key: Buffer,
  plaintext: string,
  payloadHash: string,
): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(payloadHash, "hex"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function decrypt(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  payloadHash: string,
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(payloadHash, "hex"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

type ReceiptRow = {
  receipt_id: string;
  terminal_id: string;
  channel_id: string;
  sequence: number;
  payment_id: string;
  payload_hash: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  state: string;
  attempts: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  transaction_hash: string | null;
  last_error: string | null;
};

export class VenueRelayJournal {
  readonly #database: DatabaseSync;
  readonly #key: Buffer;

  constructor(path: string, encryptionKey: Uint8Array) {
    if (encryptionKey.byteLength !== 32) throw new Error("Venue relay key must be 32 bytes");
    this.#key = Buffer.from(encryptionKey);
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS voucher_receipts (
        receipt_id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence < 4294967296),
        payment_id TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('PENDING','RETRY','SUBMITTED','SETTLED','QUARANTINED')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        transaction_hash TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(channel_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS voucher_receipts_ready
        ON voucher_receipts(state, next_attempt_at, lease_until, created_at);
      CREATE INDEX IF NOT EXISTS voucher_receipts_channel
        ON voucher_receipts(channel_id, sequence);
      CREATE TABLE IF NOT EXISTS authenticated_ingress (
        terminal_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        authenticated_at INTEGER NOT NULL,
        PRIMARY KEY(terminal_id, nonce),
        FOREIGN KEY(receipt_id) REFERENCES voucher_receipts(receipt_id)
      );
    `);
  }

  close(): void {
    this.#database.close();
    this.#key.fill(0);
  }

  ingest(receipt: VoucherReceipt, now = Date.now()): { created: boolean; record: JournalRecord } {
    return this.#ingest(receipt, now);
  }

  ingestAuthenticated(
    receipt: VoucherReceipt,
    ingress: AuthenticatedIngress,
    now = Date.now(),
  ): { created: boolean; record: JournalRecord } {
    validateReceipt(receipt);
    if (
      !hex32.test(ingress.nonce) ||
      !/^[0-9a-f]{64}$/.test(ingress.payloadHash) ||
      !Number.isSafeInteger(ingress.authenticatedAt) ||
      ingress.authenticatedAt < 0 ||
      receiptPayloadHash(receipt) !== ingress.payloadHash
    )
      throw new InvalidReceipt("Invalid authenticated ingress");
    const terminalId = receipt.terminalId.toLowerCase();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#database
        .prepare(
          "SELECT receipt_id,payload_hash FROM authenticated_ingress WHERE terminal_id=? AND nonce=?",
        )
        .get(terminalId, ingress.nonce.toLowerCase()) as
        | { receipt_id: string; payload_hash: string }
        | undefined;
      if (previous) {
        if (
          previous.receipt_id !== receipt.receiptId ||
          previous.payload_hash !== ingress.payloadHash
        )
          throw new ReceiptConflict("Authenticated ingress replay conflict");
        const record = this.get(receipt.receiptId);
        this.#database.exec("COMMIT");
        return { created: false, record };
      }
      const result = this.#ingest(receipt, now);
      this.#database
        .prepare(
          `INSERT INTO authenticated_ingress
            (terminal_id,nonce,receipt_id,payload_hash,authenticated_at) VALUES (?,?,?,?,?)`,
        )
        .run(
          terminalId,
          ingress.nonce.toLowerCase(),
          receipt.receiptId,
          ingress.payloadHash,
          ingress.authenticatedAt,
        );
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #ingest(receipt: VoucherReceipt, now: number): { created: boolean; record: JournalRecord } {
    validateReceipt(receipt);
    const canonical = canonicalReceipt(receipt);
    const payloadHash = receiptPayloadHash(receipt);
    const existing = this.#row(receipt.receiptId);
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new ReceiptConflict("Receipt ID conflict");
      return { created: false, record: this.#record(existing) };
    }
    const occupied = this.#database
      .prepare(
        "SELECT receipt_id, payload_hash FROM voucher_receipts WHERE (channel_id=? AND sequence=?) OR payment_id=? LIMIT 1",
      )
      .get(receipt.channelId.toLowerCase(), receipt.sequence, receipt.paymentId.toLowerCase()) as
      | { receipt_id: string; payload_hash: string }
      | undefined;
    if (occupied)
      throw new ReceiptConflict(
        occupied.payload_hash === payloadHash ? "Receipt identity mismatch" : "Voucher conflict",
      );
    const sealed = encrypt(this.#key, canonical, payloadHash);
    this.#database
      .prepare(
        `INSERT INTO voucher_receipts
          (receipt_id,terminal_id,channel_id,sequence,payment_id,payload_hash,nonce,ciphertext,auth_tag,state,next_attempt_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'PENDING',?,?,?)`,
      )
      .run(
        receipt.receiptId,
        receipt.terminalId.toLowerCase(),
        receipt.channelId.toLowerCase(),
        receipt.sequence,
        receipt.paymentId.toLowerCase(),
        payloadHash,
        sealed.nonce,
        sealed.ciphertext,
        sealed.tag,
        now,
        now,
        now,
      );
    return { created: true, record: this.get(receipt.receiptId) };
  }

  get(receiptId: string): JournalRecord {
    const row = this.#row(receiptId);
    if (!row) throw new InvalidReceipt("Unknown receipt");
    return this.#record(row);
  }

  leaseReady(
    limit: number,
    owner: string,
    now: number,
    leaseMilliseconds: number,
  ): JournalRecord[] {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(owner) ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1_000 ||
      leaseMilliseconds > 300_000
    )
      throw new InvalidTransition("Invalid lease request");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.#database
        .prepare(
          `SELECT r.receipt_id FROM voucher_receipts r
           WHERE r.state IN ('PENDING','RETRY','SUBMITTED') AND r.next_attempt_at <= ?
             AND (r.lease_until IS NULL OR r.lease_until <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM voucher_receipts p
               WHERE p.channel_id=r.channel_id AND p.sequence<r.sequence AND p.state!='SETTLED'
             )
           ORDER BY r.created_at,r.receipt_id LIMIT ?`,
        )
        .all(now, now, limit) as { receipt_id: string }[];
      const leased: JournalRecord[] = [];
      const update = this.#database.prepare(
        `UPDATE voucher_receipts SET lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=?
         WHERE receipt_id=? AND state IN ('PENDING','RETRY','SUBMITTED') AND (lease_until IS NULL OR lease_until<=?)`,
      );
      for (const candidate of candidates) {
        const result = update.run(owner, now + leaseMilliseconds, now, candidate.receipt_id, now);
        if (result.changes === 1) leased.push(this.get(candidate.receipt_id));
      }
      this.#database.exec("COMMIT");
      return leased;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markSubmitted(
    receiptId: string,
    owner: string,
    transactionHash: string,
    now: number,
  ): JournalRecord {
    if (!hex32.test(transactionHash)) throw new InvalidTransition("Invalid transaction hash");
    this.#transition(receiptId, owner, "SUBMITTED", now, transactionHash.toLowerCase(), null, now);
    return this.get(receiptId);
  }

  deferSubmitted(
    receiptId: string,
    owner: string,
    nextAttemptAt: number,
    now: number,
  ): JournalRecord {
    if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt <= now)
      throw new InvalidTransition("Invalid submitted deferral");
    const result = this.#database
      .prepare(
        `UPDATE voucher_receipts
         SET next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=?
         WHERE receipt_id=? AND state='SUBMITTED' AND lease_owner=? AND lease_until>?`,
      )
      .run(nextAttemptAt, now, receiptId, owner, now);
    if (result.changes !== 1) throw new InvalidTransition("Lease does not authorize deferral");
    return this.get(receiptId);
  }

  markSettled(receiptId: string, transactionHash: string, now: number): JournalRecord {
    if (!hex32.test(transactionHash)) throw new InvalidTransition("Invalid transaction hash");
    const result = this.#database
      .prepare(
        `UPDATE voucher_receipts SET state='SETTLED',transaction_hash=?,lease_owner=NULL,lease_until=NULL,last_error=NULL,updated_at=?
         WHERE receipt_id=? AND state IN ('PENDING','RETRY','SUBMITTED')`,
      )
      .run(transactionHash.toLowerCase(), now, receiptId);
    if (result.changes !== 1) throw new InvalidTransition("Receipt cannot settle");
    return this.get(receiptId);
  }

  retry(
    receiptId: string,
    owner: string,
    nextAttemptAt: number,
    error: string,
    now: number,
  ): JournalRecord {
    if (
      !Number.isSafeInteger(nextAttemptAt) ||
      nextAttemptAt <= now ||
      error.length < 1 ||
      error.length > 500
    )
      throw new InvalidTransition("Invalid retry");
    this.#transition(receiptId, owner, "RETRY", now, null, error, nextAttemptAt);
    return this.get(receiptId);
  }

  quarantine(receiptId: string, owner: string, reason: string, now: number): JournalRecord {
    if (reason.length < 1 || reason.length > 500) throw new InvalidTransition("Invalid quarantine");
    const row = this.#row(receiptId);
    this.#transition(
      receiptId,
      owner,
      "QUARANTINED",
      now,
      row?.transaction_hash ?? null,
      reason,
      now,
    );
    return this.get(receiptId);
  }

  #transition(
    receiptId: string,
    owner: string,
    state: ReceiptState,
    now: number,
    transactionHash: string | null,
    error: string | null,
    nextAttemptAt: number,
  ): void {
    if (!states.has(state)) throw new InvalidTransition("Invalid state");
    const result = this.#database
      .prepare(
        `UPDATE voucher_receipts
         SET state=?,transaction_hash=?,last_error=?,next_attempt_at=?,lease_owner=NULL,lease_until=NULL,updated_at=?
         WHERE receipt_id=? AND lease_owner=? AND lease_until>? AND state IN ('PENDING','RETRY','SUBMITTED')`,
      )
      .run(state, transactionHash, error, nextAttemptAt, now, receiptId, owner, now);
    if (result.changes !== 1) throw new InvalidTransition("Lease does not authorize transition");
  }

  #row(receiptId: string): ReceiptRow | undefined {
    return this.#database
      .prepare("SELECT * FROM voucher_receipts WHERE receipt_id=?")
      .get(receiptId) as ReceiptRow | undefined;
  }

  #record(row: ReceiptRow): JournalRecord {
    if (!states.has(row.state as ReceiptState))
      throw new InvalidTransition("Corrupt receipt state");
    const receipt = JSON.parse(
      decrypt(
        this.#key,
        Buffer.from(row.nonce),
        Buffer.from(row.ciphertext),
        Buffer.from(row.auth_tag),
        row.payload_hash,
      ),
    ) as VoucherReceipt;
    validateReceipt(receipt);
    if (
      receiptPayloadHash(receipt) !== row.payload_hash ||
      receipt.receiptId !== row.receipt_id ||
      receipt.channelId.toLowerCase() !== row.channel_id ||
      receipt.paymentId.toLowerCase() !== row.payment_id ||
      receipt.sequence !== row.sequence
    )
      throw new InvalidReceipt("Receipt storage integrity failure");
    return {
      receiptId: row.receipt_id,
      terminalId: row.terminal_id,
      channelId: row.channel_id,
      sequence: row.sequence,
      paymentId: row.payment_id,
      state: row.state as ReceiptState,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      transactionHash: row.transaction_hash,
      lastError: row.last_error,
      receipt,
    };
  }
}
