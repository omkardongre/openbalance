import {
  type AttendeeChannelState,
  createAttendeeChannelState,
  prepareOpenAuthorization,
  verifyTerminalReceiptForAuthorization,
} from "@openbalance/attendee";
import {
  canonicalVoucherReceipt,
  decodeVoucherReceipt,
  encodeChannelResponseQr,
  type OpenPaymentRequest,
  openRequestHash,
  type ReserveChannelConfig,
  type TerminalPaymentRequest,
  type VoucherReceipt,
} from "@openbalance/protocol";
import { type Address, getAddress, type Hex, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DATABASE_NAME = "openbalance-attendee-v1";
const DATABASE_VERSION = 1;
const WRAPPING_KEY_ID = "device-wrapping-key:v1";
const PRIVATE_KEY_BYTES = 32;

type StoredWrappingKey = { id: typeof WRAPPING_KEY_ID; key: CryptoKey };
type StoredChannelKey = {
  keyId: string;
  signer: Address;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  channelId: Hex | null;
  createdAt: number;
};
type StagedChannel = {
  channelId: Hex;
  state: AttendeeChannelState;
  status: "PENDING" | "ACTIVE";
  operationId: string;
  createdAt: number;
};
export type StoredAuthorization = {
  paymentId: Hex;
  channelId: Hex;
  /** Version 2 requests (the customer picks the reserve); version 1 on rows from before. */
  request: TerminalPaymentRequest | OpenPaymentRequest;
  /** The voucher this phone signed. Version 1 rows carry it inside the request instead. */
  voucher?: Hex;
  /** Its position on the reserve. Version 1 rows carry it inside the request instead. */
  sequence?: number;
  requestHash: Hex;
  attendeeSignature: Hex;
  responseQr: string;
  grossUnits: bigint;
  cumulativeGrossUnits: bigint;
  createdAt: number;
  receipt: VoucherReceipt | null;
  /**
   * Set when the terminal abandoned this approval (never confirmed it before it expired) and
   * re-requested the same sequence for the payment named here. Absent on rows from before.
   */
  supersededBy?: Hex;
};

/** The newest live (not superseded) approval on the channel at the given sequence, if any. */
async function tipAuthorization(
  store: IDBObjectStore,
  channelId: Hex,
  sequence: number,
): Promise<StoredAuthorization | undefined> {
  const rows = await requestResult(
    store.index("byChannel").getAll(channelId) as IDBRequest<StoredAuthorization[]>,
  );
  return rows.find((row) => !row.supersededBy && authorizationSequence(row) === sequence);
}

/** The voucher a stored approval signed, for either request version. */
export function authorizationVoucher(row: StoredAuthorization): Hex {
  const voucher = row.voucher ?? ("voucher" in row.request ? row.request.voucher : undefined);
  if (!voucher) throw new Error("Stored approval is missing its voucher.");
  return voucher;
}

function authorizationSequence(row: StoredAuthorization): number {
  const sequence = row.sequence ?? ("sequence" in row.request ? row.request.sequence : undefined);
  if (sequence === undefined) throw new Error("Stored approval is missing its position.");
  return sequence;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Attendee storage request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Attendee storage failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Attendee storage aborted"));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle)
    throw new Error("Secure offline storage is unavailable on this device.");
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore("deviceKeys", { keyPath: "id" });
    database
      .createObjectStore("channelKeys", { keyPath: "keyId" })
      .createIndex("bySigner", "signer", { unique: true });
    database.createObjectStore("channels", { keyPath: "channelId" });
    const authorizations = database.createObjectStore("authorizations", { keyPath: "paymentId" });
    authorizations.createIndex("byChannel", "channelId", { unique: false });
  };
  return requestResult(request);
}

async function getWrappingKey(database: IDBDatabase): Promise<CryptoKey> {
  const read = database.transaction("deviceKeys", "readonly");
  const existing = await requestResult(
    read.objectStore("deviceKeys").get(WRAPPING_KEY_ID) as IDBRequest<
      StoredWrappingKey | undefined
    >,
  );
  await transactionDone(read);
  if (existing) return existing.key;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const write = database.transaction("deviceKeys", "readwrite");
  write.objectStore("deviceKeys").add({ id: WRAPPING_KEY_ID, key } satisfies StoredWrappingKey);
  try {
    await transactionDone(write);
    return key;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "ConstraintError") throw error;
    const retry = database.transaction("deviceKeys", "readonly");
    const winner = await requestResult(
      retry.objectStore("deviceKeys").get(WRAPPING_KEY_ID) as IDBRequest<StoredWrappingKey>,
    );
    await transactionDone(retry);
    return winner.key;
  }
}

function keyAdditionalData(keyId: string, signer: Address): ArrayBuffer {
  return new TextEncoder().encode(`openbalance:attendee-channel-key:v1:${keyId}:${signer}`).buffer;
}

function newPrivateKey(): { bytes: Uint8Array<ArrayBuffer>; hex: Hex; signer: Address } {
  for (let attempts = 0; attempts < 128; attempts += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(PRIVATE_KEY_BYTES)));
    const hex =
      `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
    try {
      return { bytes, hex, signer: privateKeyToAccount(hex).address };
    } catch {
      bytes.fill(0);
    }
  }
  throw new Error("Unable to create an offline channel key.");
}

export async function createOfflineChannelKey(): Promise<{ keyId: string; signer: Address }> {
  const database = await openDatabase();
  try {
    const wrappingKey = await getWrappingKey(database);
    const keyId = `channel-key:${crypto.randomUUID()}`;
    const generated = newPrivateKey();
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: keyAdditionalData(keyId, generated.signer),
          tagLength: 128,
        },
        wrappingKey,
        generated.bytes,
      );
      const transaction = database.transaction("channelKeys", "readwrite");
      transaction.objectStore("channelKeys").add({
        keyId,
        signer: generated.signer,
        iv: iv.buffer,
        ciphertext,
        channelId: null,
        createdAt: Date.now(),
      } satisfies StoredChannelKey);
      await transactionDone(transaction);
      return { keyId, signer: generated.signer };
    } finally {
      generated.bytes.fill(0);
    }
  } finally {
    database.close();
  }
}

export async function stageOfflineChannel(input: {
  keyId: string;
  signer: Address;
  chainId: bigint;
  vault: Address;
  terminalSigner: Address;
  config: ReserveChannelConfig;
  operationId: string;
  display: AttendeeChannelState["display"];
}): Promise<void> {
  const state = createAttendeeChannelState(input);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["channelKeys", "channels"], "readwrite");
    const keys = transaction.objectStore("channelKeys");
    const channels = transaction.objectStore("channels");
    const stored = await requestResult(keys.get(input.keyId) as IDBRequest<StoredChannelKey>);
    const existing = await requestResult(
      channels.get(input.config.channelId) as IDBRequest<StagedChannel | undefined>,
    );
    if (
      existing &&
      existing.state.keyId === input.keyId &&
      existing.state.channelId === state.channelId &&
      JSON.stringify(existing.state, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ) ===
        JSON.stringify(state, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ) &&
      existing.operationId === input.operationId
    ) {
      await transactionDone(transaction);
      return;
    }
    if (existing)
      throw new Error("A different reserve draft already uses this channel identifier.");
    if (!stored || getAddress(stored.signer) !== getAddress(input.signer) || stored.channelId)
      throw new Error("Offline key is unavailable or already bound.");
    keys.put({ ...stored, channelId: input.config.channelId } satisfies StoredChannelKey);
    channels.add({
      channelId: input.config.channelId,
      state,
      status: "PENDING",
      operationId: input.operationId,
      createdAt: Date.now(),
    } satisfies StagedChannel);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function activateOfflineChannel(channelId: Hex): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("channels", "readwrite");
    const store = transaction.objectStore("channels");
    const channel = await requestResult(store.get(channelId) as IDBRequest<StagedChannel>);
    if (!channel) throw new Error("This device has no pending channel binding.");
    store.put({ ...channel, status: "ACTIVE" } satisfies StagedChannel);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function listOfflineChannels(): Promise<AttendeeChannelState[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("channels", "readonly");
    const rows = await requestResult(
      transaction.objectStore("channels").getAll() as IDBRequest<StagedChannel[]>,
    );
    await transactionDone(transaction);
    return rows.filter((row) => row.status === "ACTIVE").map((row) => row.state);
  } finally {
    database.close();
  }
}

async function decryptAndSign(database: IDBDatabase, keyId: string, digest: Hex): Promise<Hex> {
  const transaction = database.transaction("channelKeys", "readonly");
  const stored = await requestResult(
    transaction.objectStore("channelKeys").get(keyId) as IDBRequest<StoredChannelKey>,
  );
  await transactionDone(transaction);
  if (!stored) throw new Error("Offline signing key is unavailable on this device.");
  const wrappingKey = await getWrappingKey(database);
  const clear = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(stored.iv),
        additionalData: keyAdditionalData(stored.keyId, stored.signer),
        tagLength: 128,
      },
      wrappingKey,
      stored.ciphertext,
    ),
  );
  try {
    const privateKey =
      `0x${Array.from(clear, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
    return await privateKeyToAccount(privateKey).sign({ hash: digest });
  } finally {
    clear.fill(0);
  }
}

/**
 * Approves a stall's charge from the reserve the customer chose. Signing happens on this device
 * with that reserve's own key; the reserve then moves to its next position, and an earlier
 * approval the terminal never countersigned is marked replaced when the terminal asked again at
 * its position.
 */
export async function authorizeOpenRequest(input: {
  request: OpenPaymentRequest;
  channelId: Hex;
  nowSeconds?: number;
}): Promise<StoredAuthorization> {
  const database = await openDatabase();
  try {
    const requestHash = openRequestHash(input.request);
    const read = database.transaction(["channels", "authorizations"], "readonly");
    const channel = await requestResult(
      read.objectStore("channels").get(input.channelId) as IDBRequest<StagedChannel>,
    );
    const duplicate = await requestResult(
      read.objectStore("authorizations").get(input.request.paymentId) as IDBRequest<
        StoredAuthorization | undefined
      >,
    );
    const tip = channel
      ? await tipAuthorization(
          read.objectStore("authorizations"),
          input.channelId,
          channel.state.nextSequence - 1,
        )
      : undefined;
    await transactionDone(read);
    if (channel?.status !== "ACTIVE") throw new Error("This reserve is not active on this device.");
    if (duplicate) {
      // A rescan of the same charge shows the same answer; it is never signed twice.
      if (duplicate.requestHash !== requestHash)
        throw new Error("Payment identifier was already authorized for another request.");
      return duplicate;
    }
    const prepared = prepareOpenAuthorization({
      state: channel.state,
      request: input.request,
      nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1_000),
      paymentAlreadyAuthorized: false,
      tip: tip
        ? {
            paymentId: tip.paymentId,
            voucher: authorizationVoucher(tip),
            expiresAt: tip.request.expiresAt,
            receipt: tip.receipt,
          }
        : undefined,
    });
    const attendeeSignature = await decryptAndSign(
      database,
      channel.state.keyId,
      prepared.voucherDigest,
    );
    const recovered = await recoverAddress({
      hash: prepared.voucherDigest,
      signature: attendeeSignature,
    });
    if (getAddress(recovered) !== getAddress(channel.state.signer))
      throw new Error("Offline key integrity check failed.");
    const responseQr = encodeChannelResponseQr({
      version: 2,
      kind: "offline-voucher-response",
      requestHash,
      channelId: input.channelId,
      attendeeSignature,
    });
    const authorization: StoredAuthorization = {
      paymentId: input.request.paymentId,
      channelId: input.channelId,
      request: input.request,
      voucher: prepared.voucher,
      sequence: prepared.sequence,
      requestHash,
      attendeeSignature,
      responseQr,
      grossUnits: prepared.grossUnits,
      cumulativeGrossUnits: prepared.cumulativeGrossUnits,
      createdAt: Date.now(),
      receipt: null,
    };

    const write = database.transaction(["channels", "authorizations"], "readwrite");
    const channels = write.objectStore("channels");
    const current = await requestResult(channels.get(input.channelId) as IDBRequest<StagedChannel>);
    if (current?.status !== "ACTIVE" || current.state.revision !== channel.state.revision) {
      write.abort();
      throw new Error("Reserve changed while approval was in progress. Scan the stall again.");
    }
    const authorizations = write.objectStore("authorizations");
    if (prepared.supersededPaymentId) {
      // The revision check above already pins the reserve; this pins the replaced approval, so a
      // receipt stored for it in the meantime can never be silently overwritten.
      const replaced = await requestResult(
        authorizations.get(prepared.supersededPaymentId) as IDBRequest<
          StoredAuthorization | undefined
        >,
      );
      if (!replaced || replaced.receipt || replaced.supersededBy) {
        write.abort();
        throw new Error("Reserve changed while approval was in progress. Scan the stall again.");
      }
      authorizations.put({
        ...replaced,
        supersededBy: input.request.paymentId,
      } satisfies StoredAuthorization);
    }
    channels.put({ ...current, state: prepared.nextState } satisfies StagedChannel);
    authorizations.add(authorization);
    await transactionDone(write);
    return authorization;
  } finally {
    database.close();
  }
}

export async function storeTerminalReceipt(payload: string): Promise<StoredAuthorization> {
  const receipt = decodeVoucherReceipt(payload);
  const database = await openDatabase();
  try {
    const read = database.transaction(["authorizations", "channels"], "readonly");
    const authorization = await requestResult(
      read.objectStore("authorizations").get(receipt.paymentId) as IDBRequest<StoredAuthorization>,
    );
    const channel = await requestResult(
      read.objectStore("channels").get(receipt.channelId) as IDBRequest<StagedChannel>,
    );
    await transactionDone(read);
    if (authorization?.receipt) {
      if (canonicalVoucherReceipt(authorization.receipt) === payload) return authorization;
      throw new Error("A different terminal receipt is already stored for this payment.");
    }
    if (authorization?.supersededBy)
      throw new Error(
        "This approval expired and was replaced by a newer one; its receipt cannot be stored.",
      );
    if (
      !authorization ||
      channel?.status !== "ACTIVE" ||
      receipt.channelId !== authorization.channelId ||
      receipt.terminalId !== authorization.request.terminalId ||
      receipt.sequence !== authorizationSequence(authorization) ||
      receipt.voucher !== authorizationVoucher(authorization) ||
      receipt.attendeeSignature !== authorization.attendeeSignature
    )
      throw new Error("Terminal receipt does not match a locally authorized purchase.");
    await verifyTerminalReceiptForAuthorization({
      state: channel.state,
      request: {
        terminalId: authorization.request.terminalId,
        channelId: authorization.channelId,
        paymentId: authorization.paymentId,
        sequence: authorizationSequence(authorization),
        voucher: authorizationVoucher(authorization),
      },
      attendeeSignature: authorization.attendeeSignature,
      receipt,
    });
    const updated = { ...authorization, receipt } satisfies StoredAuthorization;
    const write = database.transaction("authorizations", "readwrite");
    const store = write.objectStore("authorizations");
    const current = await requestResult(
      store.get(receipt.paymentId) as IDBRequest<StoredAuthorization>,
    );
    if (!current || current.requestHash !== authorization.requestHash || current.supersededBy) {
      write.abort();
      throw new Error("Authorization changed while the receipt was being verified.");
    }
    if (current.receipt) {
      if (canonicalVoucherReceipt(current.receipt) !== payload) {
        write.abort();
        throw new Error("A different terminal receipt is already stored for this payment.");
      }
      await transactionDone(write);
      return current;
    }
    store.put(updated);
    await transactionDone(write);
    return updated;
  } finally {
    database.close();
  }
}

export async function listOfflineAuthorizations(): Promise<StoredAuthorization[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("authorizations", "readonly");
    const rows = await requestResult(
      transaction.objectStore("authorizations").getAll() as IDBRequest<StoredAuthorization[]>,
    );
    await transactionDone(transaction);
    return rows.sort((left, right) => right.createdAt - left.createdAt);
  } finally {
    database.close();
  }
}
