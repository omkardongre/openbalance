import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  decodePaymentIntent,
  encodePaymentIntent,
  orderReferenceHash,
  type PaymentIntent,
  paymentIntentDigest,
  receiptCommitment,
} from "@openbalance/protocol";
import type { Pool } from "pg";
import { encodeAbiParameters, getAddress, type Hex, keccak256, recoverAddress } from "viem";
import type { AccountIdentity } from "./account-access.js";
import type { CheckoutPolicyVerifier } from "./checkout-chain.js";
import type { CheckoutEventPolicy, CheckoutManifest } from "./checkout-manifest.js";
import type { OperationsIdentity } from "./operations-access.js";

export class CheckoutConflict extends Error {}
export class CheckoutNotFound extends Error {}
export class CheckoutRejected extends Error {}

const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/;

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

type CheckoutDisplay = {
  vendorName: string;
  orderReference: string;
  orderVersion: string;
  description: string;
  assetSymbol: string;
  assetDecimals: number;
};
type ReservePolicy = {
  vault: `0x${string}`;
  maximumReserveUnits: string;
  maximumPerVoucherUnits: string;
  maximumVoucherCount: number;
  acceptanceDurationSeconds: number;
  submissionDelaySeconds: number;
};
type OrderRow = {
  order_id: string;
  stream_id: string;
  event_id: Hex;
  vendor_id: Hex;
  terminal_instance_id: Hex;
  payment_id: Hex | null;
  payer_account: `0x${string}` | null;
  order_ref_hash: Hex;
  order_version: string;
  gross_units: string;
  encoded_intent: Hex | null;
  display: CheckoutDisplay;
  reserve_policy: ReservePolicy;
  state: "CREATED" | "BOUND" | "READY";
  terminal_signature: Hex | null;
  request_hash: Hex;
  expires_at: Date;
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function publicOrder(row: OrderRow) {
  const base = {
    schemaVersion: 1 as const,
    orderId: row.order_id,
    state: row.state,
    expiresAt: row.expires_at.toISOString(),
    grossUnits: row.gross_units,
    display: row.display,
  };
  if (!row.encoded_intent || !row.payment_id) return base;
  return {
    ...base,
    paymentId: row.payment_id,
    encodedIntent: row.encoded_intent,
    terminalSignature: row.terminal_signature,
    intentDigest: paymentIntentDigest(decodePaymentIntent(row.encoded_intent)),
    display: row.display,
    reservePolicy: row.reserve_policy,
  };
}

export class CheckoutService {
  readonly #events: CheckoutEventPolicy[];
  readonly #chainId: number;

  constructor(
    private readonly pool: Pool,
    manifest: CheckoutManifest,
    private readonly verifier: CheckoutPolicyVerifier,
    private readonly capabilityKey: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (capabilityKey.length < 32) throw new Error("Checkout capability key is too short");
    this.#events = manifest.events;
    this.#chainId = manifest.chainId;
  }

  async assertReady() {
    const result = await this.pool.query("SELECT to_regclass('public.checkout_orders') AS orders");
    if (!result.rows[0]?.orders) throw new Error("Checkout migration is not installed");
  }

  policy(identity: OperationsIdentity) {
    const { event, vendor } = this.vendorPolicy(identity);
    return {
      chainId: this.#chainId,
      eventId: event.eventId,
      vendorId: vendor.vendorId,
      vendorName: vendor.vendorName,
      assetSymbol: event.assetSymbol,
      assetDecimals: event.assetDecimals,
      asset: event.asset,
      router: event.router,
      registry: event.registry,
      destinationVersion: vendor.destinationVersion.toString(),
      terminalSigner: vendor.terminal.signer,
    };
  }

  async create(
    identity: OperationsIdentity,
    input: {
      orderReference: string;
      orderVersion: bigint;
      description: string;
      grossUnits: bigint;
      idempotencyKey: string;
    },
  ) {
    if (
      !idempotencyPattern.test(input.idempotencyKey) ||
      input.orderReference.length < 1 ||
      input.orderReference.length > 160 ||
      input.description.length < 1 ||
      input.description.length > 160 ||
      hasControlCharacters(input.orderReference) ||
      hasControlCharacters(input.description) ||
      input.orderVersion < 1n ||
      input.orderVersion >= 1n << 256n ||
      input.grossUnits < 1n ||
      input.grossUnits >= 1n << 256n
    )
      throw new CheckoutRejected();
    const { event, vendor } = this.vendorPolicy(identity);
    const orderRefHash = orderReferenceHash(input.orderReference, input.orderVersion);
    const display: CheckoutDisplay = {
      vendorName: vendor.vendorName,
      orderReference: input.orderReference,
      orderVersion: input.orderVersion.toString(),
      description: input.description,
      assetSymbol: event.assetSymbol,
      assetDecimals: event.assetDecimals,
    };
    const reservePolicy: ReservePolicy = {
      vault: event.vault,
      maximumReserveUnits: vendor.reservePolicy.maximumReserveUnits.toString(),
      maximumPerVoucherUnits: vendor.reservePolicy.maximumPerVoucherUnits.toString(),
      maximumVoucherCount: vendor.reservePolicy.maximumVoucherCount,
      acceptanceDurationSeconds: vendor.reservePolicy.acceptanceDurationSeconds,
      submissionDelaySeconds: vendor.reservePolicy.submissionDelaySeconds,
    };
    const requestHash = keccak256(
      encodeAbiParameters(
        [
          { type: "string" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "string" },
          { type: "uint256" },
        ],
        [
          identity.streamId,
          event.eventId,
          vendor.vendorId,
          orderRefHash,
          input.orderVersion,
          input.description,
          input.grossUnits,
        ],
      ),
    );
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${identity.streamId}:${vendor.vendorId}:${orderRefHash}:${input.orderVersion}`,
      ]);
      const existing = await db.query<OrderRow>(
        `SELECT * FROM checkout_orders
         WHERE (created_by=$1 AND idempotency_key=$2)
            OR (stream_id=$3 AND vendor_id=$4 AND order_ref_hash=$5 AND order_version=$6)
         FOR UPDATE`,
        [
          identity.principalId,
          input.idempotencyKey,
          identity.streamId,
          vendor.vendorId,
          orderRefHash,
          input.orderVersion.toString(),
        ],
      );
      if (
        existing.rows.length > 1 ||
        (existing.rows[0] && existing.rows[0].request_hash !== requestHash)
      )
        throw new CheckoutConflict();
      let row = existing.rows[0];
      let created = false;
      if (!row) {
        const orderId = randomUUID();
        const capability = this.capability(orderId);
        const expiresAt = new Date(this.now().getTime() + event.intentLifetimeSeconds * 1_000);
        const inserted = await db.query<OrderRow>(
          `INSERT INTO checkout_orders
           (order_id,stream_id,event_id,vendor_id,terminal_instance_id,order_ref_hash,
            order_version,gross_units,display,reserve_policy,capability_hash,created_by,
            idempotency_key,request_hash,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            orderId,
            identity.streamId,
            event.eventId,
            vendor.vendorId,
            vendor.terminal.instanceId,
            orderRefHash,
            input.orderVersion.toString(),
            input.grossUnits.toString(),
            JSON.stringify(display),
            JSON.stringify(reservePolicy),
            tokenHash(capability),
            identity.principalId,
            input.idempotencyKey,
            requestHash,
            expiresAt,
          ],
        );
        row = inserted.rows[0];
        created = true;
      }
      if (!row) throw new CheckoutRejected();
      await db.query("COMMIT");
      return { created, capability: this.capability(row.order_id), ...publicOrder(row) };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async bind(identity: AccountIdentity, orderId: string, capability: string) {
    if (!capabilityPattern.test(capability)) throw new CheckoutNotFound();
    const found = await this.pool.query<OrderRow>(
      `SELECT * FROM checkout_orders WHERE order_id=$1 AND capability_hash=$2
         AND expires_at>clock_timestamp()`,
      [orderId, tokenHash(capability)],
    );
    const current = found.rows[0];
    if (!current) throw new CheckoutNotFound();
    if (current.payer_account) {
      if (getAddress(current.payer_account) !== getAddress(identity.account))
        throw new CheckoutConflict();
      return publicOrder(current);
    }
    const { event, vendor } = this.rowPolicy(current);
    const now = Math.floor(this.now().getTime() / 1_000);
    const paymentId = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "address" },
          { type: "uint256" },
        ],
        [
          event.eventId,
          vendor.vendorId,
          current.order_ref_hash,
          getAddress(identity.account),
          BigInt(current.order_version),
        ],
      ),
    );
    const intent: PaymentIntent = {
      schemaVersion: 1,
      chainId: BigInt(this.#chainId),
      router: event.router,
      eventId: event.eventId,
      paymentId,
      payerAccount: getAddress(identity.account),
      orderRefHash: current.order_ref_hash,
      vendorId: vendor.vendorId,
      vendorDestinationVersion: vendor.destinationVersion,
      terminalInstanceId: vendor.terminal.instanceId,
      asset: event.asset,
      grossUnits: BigInt(current.gross_units),
      organizerFeeBps: event.organizerFeeBps,
      platformFeeBps: event.platformFeeBps,
      configVersion: event.configVersion,
      receiptCommitment: receiptCommitment({
        vendorName: current.display.vendorName,
        orderReference: current.display.orderReference,
        orderVersion: BigInt(current.display.orderVersion),
        description: current.display.description,
        assetSymbol: current.display.assetSymbol,
        assetDecimals: current.display.assetDecimals,
        grossUnits: BigInt(current.gross_units),
      }),
      validAfter: now,
      expiresAt: now + event.intentLifetimeSeconds,
      terminalKeyVersion: vendor.terminal.keyVersion,
    };
    try {
      await this.verifier.assert(event, vendor, intent);
    } catch {
      throw new CheckoutRejected();
    }
    const result = await this.pool.query<OrderRow>(
      `UPDATE checkout_orders SET state='BOUND',payer_account=$3,payment_id=$4,
         encoded_intent=$5,bound_at=clock_timestamp(),expires_at=$6
       WHERE order_id=$1 AND capability_hash=$2 AND state='CREATED'
         AND expires_at>clock_timestamp() RETURNING *`,
      [
        orderId,
        tokenHash(capability),
        identity.account.toLowerCase(),
        paymentId,
        encodePaymentIntent(intent),
        new Date(intent.expiresAt * 1_000),
      ],
    );
    if (result.rows[0]) return publicOrder(result.rows[0]);
    const raced = await this.pool.query<OrderRow>(
      "SELECT * FROM checkout_orders WHERE order_id=$1",
      [orderId],
    );
    const row = raced.rows[0];
    if (!row?.payer_account || getAddress(row.payer_account) !== getAddress(identity.account))
      throw new CheckoutConflict();
    return publicOrder(row);
  }

  async cashier(identity: OperationsIdentity, orderId: string) {
    const result = await this.pool.query<OrderRow>(
      `SELECT * FROM checkout_orders WHERE order_id=$1 AND stream_id=$2 AND event_id=$3
         AND vendor_id=$4 AND expires_at>clock_timestamp()`,
      [
        orderId,
        identity.streamId,
        identity.eventId.toLowerCase(),
        identity.vendorId?.toLowerCase(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutNotFound();
    return { capability: this.capability(row.order_id), ...publicOrder(row) };
  }

  async attachSignature(identity: OperationsIdentity, orderId: string, terminalSignature: Hex) {
    if (!signaturePattern.test(terminalSignature)) throw new CheckoutRejected();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query<OrderRow>(
        `SELECT * FROM checkout_orders WHERE order_id=$1 AND stream_id=$2 AND event_id=$3
           AND vendor_id=$4 AND expires_at>clock_timestamp() FOR UPDATE`,
        [
          orderId,
          identity.streamId,
          identity.eventId.toLowerCase(),
          identity.vendorId?.toLowerCase(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new CheckoutNotFound();
      if (!row.encoded_intent || row.state === "CREATED") throw new CheckoutConflict();
      const { vendor } = this.rowPolicy(row);
      const signer = await recoverAddress({
        hash: paymentIntentDigest(decodePaymentIntent(row.encoded_intent)),
        signature: terminalSignature,
      });
      if (signer !== vendor.terminal.signer) throw new CheckoutRejected();
      if (
        row.state === "READY" &&
        row.terminal_signature?.toLowerCase() !== terminalSignature.toLowerCase()
      )
        throw new CheckoutConflict();
      const updated =
        row.state === "READY"
          ? row
          : (
              await db.query<OrderRow>(
                `UPDATE checkout_orders SET state='READY',terminal_signature=$2,
                   ready_at=clock_timestamp() WHERE order_id=$1 AND state='BOUND' RETURNING *`,
                [row.order_id, terminalSignature.toLowerCase()],
              )
            ).rows[0];
      if (!updated) throw new CheckoutConflict();
      await db.query("COMMIT");
      return { capability: this.capability(updated.order_id), ...publicOrder(updated) };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async resolve(orderId: string, authorization: string | undefined) {
    const match = /^Checkout ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match?.[1]) throw new CheckoutNotFound();
    const result = await this.pool.query<OrderRow>(
      `SELECT * FROM checkout_orders WHERE order_id=$1 AND capability_hash=$2
         AND expires_at>clock_timestamp()`,
      [orderId, tokenHash(match[1])],
    );
    const row = result.rows[0];
    if (!row) throw new CheckoutNotFound();
    if (row.state !== "READY" || !row.encoded_intent || !row.terminal_signature)
      return publicOrder(row);
    return {
      schemaVersion: 1 as const,
      orderId: row.order_id,
      encodedIntent: row.encoded_intent,
      terminalSignature: row.terminal_signature,
      display: row.display,
      reservePolicy: row.reserve_policy,
    };
  }

  private vendorPolicy(identity: OperationsIdentity) {
    const event = this.#events.find(
      (candidate) =>
        candidate.streamId === identity.streamId &&
        candidate.eventId === identity.eventId.toLowerCase(),
    );
    const vendor = event?.vendors.find(
      (candidate) => candidate.vendorId === identity.vendorId?.toLowerCase(),
    );
    if (!event || !vendor) throw new CheckoutRejected();
    return { event, vendor };
  }

  private rowPolicy(row: OrderRow) {
    const event = this.#events.find(
      (candidate) =>
        candidate.streamId === row.stream_id && candidate.eventId === row.event_id.toLowerCase(),
    );
    const vendor = event?.vendors.find(
      (candidate) => candidate.vendorId === row.vendor_id.toLowerCase(),
    );
    if (!event || !vendor || vendor.terminal.instanceId !== row.terminal_instance_id.toLowerCase())
      throw new CheckoutRejected();
    return { event, vendor };
  }

  private capability(orderId: string) {
    return createHmac("sha256", this.capabilityKey)
      .update(`checkout:v1:${orderId}`)
      .digest("base64url");
  }
}
