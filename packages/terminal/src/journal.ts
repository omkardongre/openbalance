import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  decodeOfflineVoucher,
  encodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
  type ReserveChannelConfig,
  type VoucherReceipt,
  validateReserveChannelConfig,
  validateVoucherReceipt,
} from "@openbalance/protocol";
import { getAddress, type Hex, recoverAddress, sha256, stringToHex } from "viem";
import {
  type AttendeeVoucherResponse,
  paymentRequestHash,
  receiptFromExchange,
  type TerminalPaymentRequest,
  verifyAttendeeResponse,
} from "./qr.js";

export type TerminalChannelSnapshot = {
  chainId: bigint;
  vault: `0x${string}`;
  terminalSigner: `0x${string}`;
  config: ReserveChannelConfig;
};

export type StoredUploadAuthorization = {
  keyVersion: string;
  sentAt: number;
  nonce: Hex;
  signature: Hex;
};

export type TerminalSaleState =
  | "PREPARED"
  | "ATTENDEE_SIGNED"
  | "ACCEPTED"
  | "RETRY"
  | "UPLOADING"
  | "UPLOADED"
  | "SETTLED"
  | "QUARANTINED";

type SalePayload = {
  request: TerminalPaymentRequest;
  attendeeSignature: Hex | null;
  terminalSignature: Hex | null;
  receiptId: string | null;
  uploadAuthorization: StoredUploadAuthorization | null;
};

export type TerminalSale = {
  requestId: string;
  state: TerminalSaleState;
  attempts: number;
  nextUploadAt: number;
  transactionHash: Hex | null;
  lastError: string | null;
  request: TerminalPaymentRequest;
  receipt: VoucherReceipt | null;
  uploadAuthorization: StoredUploadAuthorization | null;
};

type ChannelRow = {
  channel_id: string;
  snapshot: string;
  snapshot_hash: string;
  next_sequence: number;
  cumulative_gross: string;
  last_voucher_digest: string;
};

type SaleRow = {
  request_id: string;
  channel_id: string;
  sequence: number;
  payment_id: string;
  state: string;
  attempts: number;
  next_upload_at: number;
  lease_owner: string | null;
  lease_until: number | null;
  transaction_hash: string | null;
  last_error: string | null;
  payload_hash: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
};

const states = new Set<TerminalSaleState>([
  "PREPARED",
  "ATTENDEE_SIGNED",
  "ACCEPTED",
  "RETRY",
  "UPLOADING",
  "UPLOADED",
  "SETTLED",
  "QUARANTINED",
]);
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const signature = /^0x[0-9a-fA-F]{130}$/;

export class TerminalJournalConflict extends Error {}
export class InvalidTerminalTransition extends Error {}

function isConstraintFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_SQLITE_CONSTRAINT")
  );
}

function canonicalSnapshot(snapshot: TerminalChannelSnapshot): string {
  validateReserveChannelConfig(snapshot.config);
  if (
    snapshot.chainId <= 0n ||
    getAddress(snapshot.vault) === "0x0000000000000000000000000000000000000000" ||
    getAddress(snapshot.terminalSigner) === "0x0000000000000000000000000000000000000000"
  )
    throw new Error("Invalid terminal channel snapshot");
  return JSON.stringify({
    chainId: snapshot.chainId.toString(),
    vault: getAddress(snapshot.vault),
    terminalSigner: getAddress(snapshot.terminalSigner),
    config: {
      ...snapshot.config,
      asset: getAddress(snapshot.config.asset),
      attendeeChannelSigner: getAddress(snapshot.config.attendeeChannelSigner),
      reserveUnits: snapshot.config.reserveUnits.toString(),
      vendorDestinationVersion: snapshot.config.vendorDestinationVersion.toString(),
      terminalKeyVersion: snapshot.config.terminalKeyVersion.toString(),
      configVersion: snapshot.config.configVersion.toString(),
      maxPerVoucher: snapshot.config.maxPerVoucher.toString(),
    },
  });
}

function parseSnapshot(value: string): TerminalChannelSnapshot {
  const parsed = JSON.parse(value) as {
    chainId: string;
    vault: `0x${string}`;
    terminalSigner: `0x${string}`;
    config: Omit<
      ReserveChannelConfig,
      | "reserveUnits"
      | "vendorDestinationVersion"
      | "terminalKeyVersion"
      | "configVersion"
      | "maxPerVoucher"
    > & {
      reserveUnits: string;
      vendorDestinationVersion: string;
      terminalKeyVersion: string;
      configVersion: string;
      maxPerVoucher: string;
    };
  };
  return {
    chainId: BigInt(parsed.chainId),
    vault: parsed.vault,
    terminalSigner: parsed.terminalSigner,
    config: {
      ...parsed.config,
      reserveUnits: BigInt(parsed.config.reserveUnits),
      vendorDestinationVersion: BigInt(parsed.config.vendorDestinationVersion),
      terminalKeyVersion: BigInt(parsed.config.terminalKeyVersion),
      configVersion: BigInt(parsed.config.configVersion),
      maxPerVoucher: BigInt(parsed.config.maxPerVoucher),
    },
  };
}

function payloadHash(payload: SalePayload): string {
  return sha256(stringToHex(JSON.stringify(payload))).slice(2);
}

function seal(key: Buffer, payload: SalePayload) {
  const hash = payloadHash(payload);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(hash, "hex"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return { hash, nonce, ciphertext, tag: cipher.getAuthTag() };
}

function open(key: Buffer, row: SaleRow): SalePayload {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce));
  decipher.setAAD(Buffer.from(row.payload_hash, "hex"));
  decipher.setAuthTag(Buffer.from(row.auth_tag));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
  const payload = JSON.parse(plaintext) as SalePayload;
  if (payloadHash(payload) !== row.payload_hash)
    throw new InvalidTerminalTransition("Terminal journal payload integrity failure");
  return payload;
}

export class TerminalJournal {
  readonly #database: DatabaseSync;
  readonly #key: Buffer;

  constructor(path: string, encryptionKey: Uint8Array) {
    if (encryptionKey.byteLength !== 32) throw new Error("Terminal journal key must be 32 bytes");
    this.#key = Buffer.from(encryptionKey);
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS terminal_channels (
        channel_id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        next_sequence INTEGER NOT NULL CHECK(next_sequence > 0 AND next_sequence < 4294967296),
        cumulative_gross TEXT NOT NULL,
        last_voucher_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terminal_sales (
        request_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0 AND sequence < 4294967296),
        payment_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('PREPARED','ATTENDEE_SIGNED','ACCEPTED','RETRY','UPLOADING','UPLOADED','SETTLED','QUARANTINED')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_upload_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        transaction_hash TEXT,
        last_error TEXT,
        payload_hash TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(channel_id, sequence),
        FOREIGN KEY(channel_id) REFERENCES terminal_channels(channel_id)
      );
      CREATE INDEX IF NOT EXISTS terminal_sales_upload
        ON terminal_sales(state,next_upload_at,lease_until,created_at);
    `);
  }

  close(): void {
    this.#database.close();
    this.#key.fill(0);
  }

  registerChannel(snapshot: TerminalChannelSnapshot, now = Date.now()): { created: boolean } {
    const canonical = canonicalSnapshot(snapshot);
    const hash = sha256(stringToHex(canonical)).slice(2);
    const channelId = snapshot.config.channelId.toLowerCase();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#channelRow(channelId);
      if (existing) {
        if (existing.snapshot_hash !== hash)
          throw new TerminalJournalConflict("Channel snapshot conflict");
        this.#database.exec("COMMIT");
        return { created: false };
      }
      this.#database
        .prepare(
          `INSERT INTO terminal_channels
            (channel_id,snapshot,snapshot_hash,next_sequence,cumulative_gross,last_voucher_digest,created_at,updated_at)
           VALUES (?,?,?,1,'0',?,?,?)`,
        )
        .run(channelId, canonical, hash, snapshot.config.genesisDigest.toLowerCase(), now, now);
      this.#database.exec("COMMIT");
      return { created: true };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  prepareSale(
    input: {
      requestId: string;
      channelId: Hex;
      paymentId: Hex;
      orderRefHash: Hex;
      grossUnits: bigint;
      receiptCommitment: Hex;
      acceptedAt: number;
      expiresAt: number;
    },
    now = Date.now(),
  ): TerminalSale {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.requestId) ||
      !hex32.test(input.channelId) ||
      !hex32.test(input.paymentId) ||
      !hex32.test(input.orderRefHash) ||
      !hex32.test(input.receiptCommitment) ||
      input.grossUnits <= 0n ||
      !Number.isSafeInteger(input.acceptedAt) ||
      !Number.isSafeInteger(input.expiresAt)
    )
      throw new InvalidTerminalTransition("Invalid sale request");
    const channelRow = this.#channelRow(input.channelId.toLowerCase());
    if (!channelRow) throw new InvalidTerminalTransition("Unknown terminal channel");
    const snapshot = this.#snapshotFromRow(channelRow);
    const sequence = channelRow.next_sequence;
    const cumulativeGrossUnits = BigInt(channelRow.cumulative_gross) + input.grossUnits;
    if (
      input.acceptedAt < snapshot.config.acceptFrom ||
      input.acceptedAt >= snapshot.config.acceptUntil ||
      input.expiresAt < input.acceptedAt ||
      input.expiresAt > snapshot.config.acceptUntil ||
      input.grossUnits > snapshot.config.maxPerVoucher ||
      cumulativeGrossUnits > snapshot.config.reserveUnits ||
      sequence > snapshot.config.maxVoucherCount
    )
      throw new InvalidTerminalTransition("Sale exceeds channel policy");
    const voucher: OfflineVoucher = {
      protocolVersion: 1,
      chainId: snapshot.chainId,
      vault: snapshot.vault,
      channelId: snapshot.config.channelId,
      sequence,
      previousVoucherDigest: channelRow.last_voucher_digest as Hex,
      paymentId: input.paymentId,
      orderRefHash: input.orderRefHash,
      grossUnits: input.grossUnits,
      cumulativeGrossUnits,
      receiptCommitment: input.receiptCommitment,
      acceptedAt: input.acceptedAt,
      acceptUntil: snapshot.config.acceptUntil,
      submitUntil: snapshot.config.submitUntil,
      configVersion: snapshot.config.configVersion,
    };
    const request: TerminalPaymentRequest = {
      version: 1,
      kind: "offline-payment-request",
      requestId: input.requestId,
      terminalId: snapshot.config.terminalInstanceId,
      channelId: input.channelId,
      paymentId: input.paymentId,
      sequence,
      voucher: encodeOfflineVoucher(voucher),
      expiresAt: input.expiresAt,
    };
    const payload: SalePayload = {
      request,
      attendeeSignature: null,
      terminalSignature: null,
      receiptId: null,
      uploadAuthorization: null,
    };
    const sealed = seal(this.#key, payload);
    try {
      this.#database
        .prepare(
          `INSERT INTO terminal_sales
            (request_id,channel_id,sequence,payment_id,state,next_upload_at,payload_hash,nonce,ciphertext,auth_tag,created_at,updated_at)
           VALUES (?,?,?,?,'PREPARED',?,?,?,?,?,?,?)`,
        )
        .run(
          input.requestId,
          input.channelId.toLowerCase(),
          sequence,
          input.paymentId.toLowerCase(),
          now,
          sealed.hash,
          sealed.nonce,
          sealed.ciphertext,
          sealed.tag,
          now,
          now,
        );
    } catch (error) {
      if (!isConstraintFailure(error)) throw error;
      const existing = this.#saleRow(input.requestId);
      if (existing) {
        const sale = this.#sale(existing);
        if (paymentRequestHash(sale.request) === paymentRequestHash(request)) return sale;
      }
      throw new TerminalJournalConflict("Sale request, payment, or sequence conflict");
    }
    return this.getSale(input.requestId);
  }

  async recordAttendeeResponse(
    requestId: string,
    response: AttendeeVoucherResponse,
    nowSeconds: number,
    now = Date.now(),
  ): Promise<TerminalSale> {
    const row = this.#requiredSaleRow(requestId);
    const payload = open(this.#key, row);
    if (row.state !== "PREPARED" && row.state !== "ATTENDEE_SIGNED")
      throw new InvalidTerminalTransition("Sale cannot accept an attendee response");
    const snapshot = this.#snapshot(row.channel_id);
    const attendeeSignature = await verifyAttendeeResponse({
      request: payload.request,
      response,
      attendeeSigner: snapshot.config.attendeeChannelSigner,
      nowSeconds,
    });
    if (payload.attendeeSignature && payload.attendeeSignature !== attendeeSignature)
      throw new TerminalJournalConflict("Attendee signature conflict");
    payload.attendeeSignature = attendeeSignature;
    this.#updatePayload(row, payload, "ATTENDEE_SIGNED", now);
    return this.getSale(requestId);
  }

  async acceptSale(
    requestId: string,
    receiptId: string,
    terminalSignature: Hex,
    now = Date.now(),
  ): Promise<TerminalSale> {
    if (!signature.test(terminalSignature))
      throw new InvalidTerminalTransition("Invalid terminal signature");
    const initial = this.#requiredSaleRow(requestId);
    const initialPayload = open(this.#key, initial);
    if (!initialPayload.attendeeSignature)
      throw new InvalidTerminalTransition("Attendee signature is required");
    const snapshot = this.#snapshot(initial.channel_id);
    const voucher = decodeOfflineVoucher(initialPayload.request.voucher);
    let recovered: `0x${string}`;
    try {
      recovered = await recoverAddress({
        hash: offlineVoucherDigest(voucher),
        signature: terminalSignature,
      });
    } catch {
      throw new InvalidTerminalTransition("Terminal signature is invalid");
    }
    if (getAddress(recovered) !== getAddress(snapshot.terminalSigner))
      throw new InvalidTerminalTransition("Terminal signature does not match channel snapshot");
    const receipt = receiptFromExchange({
      request: initialPayload.request,
      receiptId,
      attendeeSignature: initialPayload.attendeeSignature,
      terminalSignature,
    });
    validateVoucherReceipt(receipt);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requiredSaleRow(requestId);
      const payload = open(this.#key, row);
      if (row.state === "ACCEPTED" || row.state === "RETRY" || row.state === "UPLOADING") {
        const current = this.#sale(row);
        if (
          current.receipt?.receiptId === receiptId &&
          current.receipt.terminalSignature.toLowerCase() === terminalSignature.toLowerCase()
        ) {
          this.#database.exec("COMMIT");
          return current;
        }
        throw new TerminalJournalConflict("Accepted receipt conflict");
      }
      if (row.state !== "ATTENDEE_SIGNED")
        throw new InvalidTerminalTransition("Sale is not ready for terminal acceptance");
      const channel = this.#channelRow(row.channel_id);
      if (
        !channel ||
        channel.next_sequence !== row.sequence ||
        channel.last_voucher_digest.toLowerCase() !== voucher.previousVoucherDigest.toLowerCase() ||
        BigInt(channel.cumulative_gross) + voucher.grossUnits !== voucher.cumulativeGrossUnits
      )
        throw new TerminalJournalConflict("Channel cursor changed before acceptance");
      payload.receiptId = receiptId;
      payload.terminalSignature = terminalSignature;
      const sealed = seal(this.#key, payload);
      const updated = this.#database
        .prepare(
          `UPDATE terminal_sales SET state='ACCEPTED',payload_hash=?,nonce=?,ciphertext=?,auth_tag=?,next_upload_at=?,updated_at=?
           WHERE request_id=? AND state='ATTENDEE_SIGNED'`,
        )
        .run(sealed.hash, sealed.nonce, sealed.ciphertext, sealed.tag, now, now, requestId);
      if (updated.changes !== 1)
        throw new InvalidTerminalTransition("Sale acceptance transition failed");
      const channelUpdated = this.#database
        .prepare(
          `UPDATE terminal_channels SET next_sequence=?,cumulative_gross=?,last_voucher_digest=?,updated_at=?
           WHERE channel_id=? AND next_sequence=?`,
        )
        .run(
          row.sequence + 1,
          voucher.cumulativeGrossUnits.toString(),
          offlineVoucherDigest(voucher).toLowerCase(),
          now,
          row.channel_id,
          row.sequence,
        );
      if (channelUpdated.changes !== 1)
        throw new TerminalJournalConflict("Channel cursor changed during acceptance");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.getSale(requestId);
  }

  getSale(requestId: string): TerminalSale {
    return this.#sale(this.#requiredSaleRow(requestId));
  }

  leaseUploads(
    limit: number,
    owner: string,
    now: number,
    leaseMilliseconds: number,
  ): TerminalSale[] {
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
      throw new InvalidTerminalTransition("Invalid upload lease request");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.#database
        .prepare(
          `SELECT s.request_id FROM terminal_sales s
           WHERE s.state IN ('ACCEPTED','RETRY','UPLOADING') AND s.next_upload_at<=?
             AND (s.lease_until IS NULL OR s.lease_until<=?)
             AND NOT EXISTS (
               SELECT 1 FROM terminal_sales p WHERE p.channel_id=s.channel_id AND p.sequence<s.sequence
                 AND p.state NOT IN ('UPLOADED','SETTLED')
             )
           ORDER BY s.created_at,s.request_id LIMIT ?`,
        )
        .all(now, now, limit) as { request_id: string }[];
      const update = this.#database.prepare(
        `UPDATE terminal_sales SET lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=?
         WHERE request_id=? AND state IN ('ACCEPTED','RETRY','UPLOADING')
           AND (lease_until IS NULL OR lease_until<=?)`,
      );
      const leased: TerminalSale[] = [];
      for (const candidate of candidates) {
        if (
          update.run(owner, now + leaseMilliseconds, now, candidate.request_id, now).changes === 1
        )
          leased.push(this.getSale(candidate.request_id));
      }
      this.#database.exec("COMMIT");
      return leased;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  saveUploadAuthorization(
    requestId: string,
    owner: string,
    authorization: StoredUploadAuthorization,
    now: number,
  ): TerminalSale {
    if (
      !/^[1-9][0-9]*$/.test(authorization.keyVersion) ||
      !Number.isSafeInteger(authorization.sentAt) ||
      authorization.sentAt < 0 ||
      !hex32.test(authorization.nonce) ||
      !signature.test(authorization.signature)
    )
      throw new InvalidTerminalTransition("Invalid upload authorization");
    const row = this.#leasedRow(requestId, owner, now);
    const payload = open(this.#key, row);
    payload.uploadAuthorization = authorization;
    this.#updatePayload(row, payload, "UPLOADING", now, owner);
    return this.getSale(requestId);
  }

  markUploaded(requestId: string, owner: string, now: number): TerminalSale {
    this.#leasedTransition(requestId, owner, "UPLOADED", now, now, null);
    return this.getSale(requestId);
  }

  retryUpload(
    requestId: string,
    owner: string,
    nextUploadAt: number,
    error: string,
    now: number,
  ): TerminalSale {
    if (!Number.isSafeInteger(nextUploadAt) || nextUploadAt <= now || error.length > 500)
      throw new InvalidTerminalTransition("Invalid upload retry");
    this.#leasedTransition(requestId, owner, "RETRY", now, nextUploadAt, error || "Upload failed");
    return this.getSale(requestId);
  }

  quarantine(requestId: string, owner: string, reason: string, now: number): TerminalSale {
    if (reason.length < 1 || reason.length > 500)
      throw new InvalidTerminalTransition("Invalid quarantine reason");
    this.#leasedTransition(requestId, owner, "QUARANTINED", now, now, reason);
    return this.getSale(requestId);
  }

  #leasedTransition(
    requestId: string,
    owner: string,
    state: TerminalSaleState,
    now: number,
    nextUploadAt: number,
    error: string | null,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE terminal_sales SET state=?,next_upload_at=?,last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=?
         WHERE request_id=? AND lease_owner=? AND lease_until>? AND state IN ('ACCEPTED','RETRY','UPLOADING')`,
      )
      .run(state, nextUploadAt, error, now, requestId, owner, now);
    if (result.changes !== 1)
      throw new InvalidTerminalTransition("Upload lease does not authorize transition");
  }

  #updatePayload(
    row: SaleRow,
    payload: SalePayload,
    state: TerminalSaleState,
    now: number,
    leaseOwner?: string,
  ): void {
    const sealed = seal(this.#key, payload);
    const result = leaseOwner
      ? this.#database
          .prepare(
            `UPDATE terminal_sales SET state=?,payload_hash=?,nonce=?,ciphertext=?,auth_tag=?,updated_at=?
             WHERE request_id=? AND lease_owner=? AND lease_until>?`,
          )
          .run(
            state,
            sealed.hash,
            sealed.nonce,
            sealed.ciphertext,
            sealed.tag,
            now,
            row.request_id,
            leaseOwner,
            now,
          )
      : this.#database
          .prepare(
            `UPDATE terminal_sales SET state=?,payload_hash=?,nonce=?,ciphertext=?,auth_tag=?,updated_at=?
             WHERE request_id=? AND state=?`,
          )
          .run(
            state,
            sealed.hash,
            sealed.nonce,
            sealed.ciphertext,
            sealed.tag,
            now,
            row.request_id,
            row.state,
          );
    if (result.changes !== 1)
      throw new InvalidTerminalTransition("Terminal journal state changed concurrently");
  }

  #snapshot(channelId: string): TerminalChannelSnapshot {
    const row = this.#channelRow(channelId);
    if (!row) throw new InvalidTerminalTransition("Unknown terminal channel");
    return this.#snapshotFromRow(row);
  }

  #snapshotFromRow(row: ChannelRow): TerminalChannelSnapshot {
    if (sha256(stringToHex(row.snapshot)).slice(2) !== row.snapshot_hash)
      throw new InvalidTerminalTransition("Terminal channel snapshot integrity failure");
    const snapshot = parseSnapshot(row.snapshot);
    if (canonicalSnapshot(snapshot) !== row.snapshot)
      throw new InvalidTerminalTransition("Terminal channel snapshot is not canonical");
    return snapshot;
  }

  #channelRow(channelId: string): ChannelRow | undefined {
    return this.#database
      .prepare("SELECT * FROM terminal_channels WHERE channel_id=?")
      .get(channelId.toLowerCase()) as ChannelRow | undefined;
  }

  #saleRow(requestId: string): SaleRow | undefined {
    return this.#database
      .prepare("SELECT * FROM terminal_sales WHERE request_id=?")
      .get(requestId) as SaleRow | undefined;
  }

  #requiredSaleRow(requestId: string): SaleRow {
    const row = this.#saleRow(requestId);
    if (!row) throw new InvalidTerminalTransition("Unknown terminal sale");
    return row;
  }

  #leasedRow(requestId: string, owner: string, now: number): SaleRow {
    const row = this.#requiredSaleRow(requestId);
    if (row.lease_owner !== owner || row.lease_until === null || row.lease_until <= now)
      throw new InvalidTerminalTransition("Upload lease does not authorize transition");
    return row;
  }

  #sale(row: SaleRow): TerminalSale {
    if (!states.has(row.state as TerminalSaleState))
      throw new InvalidTerminalTransition("Corrupt terminal sale state");
    const payload = open(this.#key, row);
    if (
      payload.request.requestId !== row.request_id ||
      payload.request.channelId.toLowerCase() !== row.channel_id ||
      payload.request.sequence !== row.sequence ||
      payload.request.paymentId.toLowerCase() !== row.payment_id
    )
      throw new InvalidTerminalTransition("Terminal sale metadata integrity failure");
    const receipt =
      payload.receiptId && payload.attendeeSignature && payload.terminalSignature
        ? receiptFromExchange({
            request: payload.request,
            receiptId: payload.receiptId,
            attendeeSignature: payload.attendeeSignature,
            terminalSignature: payload.terminalSignature,
          })
        : null;
    if (receipt) validateVoucherReceipt(receipt);
    return {
      requestId: row.request_id,
      state: row.state as TerminalSaleState,
      attempts: row.attempts,
      nextUploadAt: row.next_upload_at,
      transactionHash: row.transaction_hash as Hex | null,
      lastError: row.last_error,
      request: payload.request,
      receipt,
      uploadAuthorization: payload.uploadAuthorization,
    };
  }
}
