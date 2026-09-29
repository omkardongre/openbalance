import {
  decodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
  resilienceVaultAbi,
} from "@openbalance/protocol";
import type { Pool } from "pg";
import { encodeFunctionData, getAddress, type Hex, keccak256 } from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";
import type { FinancialOperationJournal } from "./financial-operations.js";
import { actorFor, VendorCommandRejected } from "./vendor-commands.js";
import type { VendorTreasuryIdentity } from "./vendor-treasury-access.js";

type JournalPort = Pick<FinancialOperationJournal, "accept">;

/** The finalized facts about a channel that decide whether a vendor may submit its vouchers. */
export type FinalizedChannel = {
  vendorId: Hex;
  nextSequence: number;
  submitUntil: bigint;
  reclaimed: boolean;
};

const signature = /^0x[0-9a-fA-F]{130}$/;

/**
 * The channel is not in the finalized projection. Distinct from a rejection because it is also what
 * a caller sees in the gap between a channel finalizing and the indexer projecting it.
 */
export class VoucherChannelNotFound extends Error {}

/**
 * Sponsors submission of a dual-signed offline voucher to the event vault.
 *
 * `settleVoucher` is permissionless and checks both signatures on-chain, so sponsorship adds no
 * authority: it only decides whose gas pays. That decision is scoped to the vendor treasury that owns
 * the channel's terminal, read from the finalized channel projection, so a sponsor key never pays for a
 * voucher against another vendor's channel or a channel that is closed, reclaimed or unknown.
 *
 * Vouchers in one channel must land in sequence. A voucher accepted ahead of its predecessor simply
 * fails simulation until the predecessor finalizes, and the worker retries it as a transient failure,
 * so submission order across terminals and relays does not need coordinating here.
 */
export class VendorVoucherSettlementService {
  readonly #journal: JournalPort;
  readonly #manifest: FinancialEventManifest;
  readonly #channel: (eventId: Hex, channelId: Hex) => Promise<FinalizedChannel | undefined>;
  readonly #maximumLifetimeSeconds: bigint;
  readonly #chainSeconds: () => Promise<bigint>;

  constructor(input: {
    journal: JournalPort;
    manifest: FinancialEventManifest;
    channel: (eventId: Hex, channelId: Hex) => Promise<FinalizedChannel | undefined>;
    maximumLifetimeSeconds: bigint;
    /** Submission cutoff is `block.timestamp < submitUntil`, so it is judged on the chain clock. */
    chainSeconds: () => Promise<bigint>;
  }) {
    if (input.maximumLifetimeSeconds < 30n || input.maximumLifetimeSeconds > 86_400n)
      throw new Error("Invalid voucher settlement policy");
    this.#journal = input.journal;
    this.#manifest = input.manifest;
    this.#channel = input.channel;
    this.#maximumLifetimeSeconds = input.maximumLifetimeSeconds;
    this.#chainSeconds = input.chainSeconds;
  }

  async accept(input: {
    identity: VendorTreasuryIdentity;
    channelId: Hex;
    voucher: Hex;
    attendeeSignature: Hex;
    terminalSignature: Hex;
    idempotencyKey: string;
  }) {
    let voucher: OfflineVoucher;
    let digest: Hex;
    try {
      voucher = decodeOfflineVoucher(input.voucher);
      digest = offlineVoucherDigest(voucher);
    } catch {
      throw new VendorCommandRejected("Voucher is invalid");
    }
    if (!signature.test(input.attendeeSignature) || !signature.test(input.terminalSignature))
      throw new VendorCommandRejected("Voucher signatures are invalid");

    const event = this.#manifest.events.find(
      (candidate) => candidate.eventId.toLowerCase() === input.identity.eventId.toLowerCase(),
    );
    if (
      !event ||
      voucher.chainId !== BigInt(this.#manifest.chainId) ||
      getAddress(voucher.vault) !== event.vault ||
      voucher.channelId.toLowerCase() !== input.channelId.toLowerCase()
    )
      throw new VendorCommandRejected("Voucher is outside the vendor treasury scope");

    const channel = await this.#channel(event.eventId, voucher.channelId);
    // Another vendor's channel reads as missing, so the route does not reveal which channels exist.
    if (!channel || channel.vendorId.toLowerCase() !== input.identity.vendorId.toLowerCase())
      throw new VoucherChannelNotFound();
    if (channel.reclaimed || voucher.sequence < channel.nextSequence)
      throw new VendorCommandRejected("Voucher is already settled or the channel is closed");
    if (BigInt(voucher.submitUntil) !== channel.submitUntil)
      throw new VendorCommandRejected("Voucher terms do not match the channel");

    const nowSeconds = await this.#chainSeconds();
    if (channel.submitUntil <= nowSeconds)
      throw new VendorCommandRejected("Voucher submission window has closed");
    // A sponsored command must not outlive the window in which the chain would still accept it.
    const cap = nowSeconds + this.#maximumLifetimeSeconds;
    const expiresAt = channel.submitUntil < cap ? channel.submitUntil : cap;

    const calldata = encodeFunctionData({
      abi: resilienceVaultAbi,
      functionName: "settleVoucher",
      args: [voucher, input.attendeeSignature, input.terminalSignature],
    });
    const accepted = await this.#journal.accept({
      actorId: actorFor(input.identity),
      kind: "VOUCHER_SETTLE",
      idempotencyKey: input.idempotencyKey,
      commandDigest: keccak256(calldata),
      aggregateId: voucher.paymentId,
      targetAddress: event.vault,
      calldata,
      expiresAt: new Date(Number(expiresAt) * 1_000),
    });
    return {
      created: accepted.created,
      operationId: accepted.operation.operationId,
      kind: accepted.operation.kind,
      aggregateId: accepted.operation.aggregateId,
      voucherDigest: digest,
      state: accepted.operation.state,
      statusUrl: `/v1/vendor-financial-operations/${accepted.operation.operationId}`,
    };
  }
}

/** Reads a channel from the finalized projection, joined to the event that opened it. */
export function finalizedChannelReader(pool: Pool) {
  return async (eventId: Hex, channelId: Hex): Promise<FinalizedChannel | undefined> => {
    const result = await pool.query<{
      vendor_id: Hex;
      next_sequence: string;
      submit_until: string;
      reclaimed: boolean;
    }>(
      `SELECT ch.vendor_id,ch.next_sequence::text,ch.submit_until::text,ch.reclaimed
       FROM channel_projections ch
       JOIN finalized_chain_logs l ON l.transition_id=ch.opened_transition_id
       WHERE ch.channel_id=$1 AND l.event_id=$2
       LIMIT 2`,
      [channelId.toLowerCase(), eventId.toLowerCase()],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row) return undefined;
    return {
      vendorId: row.vendor_id,
      nextSequence: Number(row.next_sequence),
      submitUntil: BigInt(row.submit_until),
      reclaimed: row.reclaimed,
    };
  };
}
