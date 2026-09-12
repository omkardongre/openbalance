import type { AccountIdentity } from "@openbalance/api/account-access";
import { resilienceVaultAbi } from "@openbalance/protocol";
import type { Pool } from "pg";
import { encodeFunctionData, type Hex, keccak256 } from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";
import type { FinancialOperationJournal } from "./financial-operations.js";

type JournalPort = Pick<FinancialOperationJournal, "accept">;

export type ReclaimRejectionCode =
  | "channel_not_found"
  | "reclaim_not_yet_eligible"
  | "channel_already_reclaimed";

export class AttendeeReclaimRejected extends Error {
  constructor(readonly code: ReclaimRejectionCode) {
    super(code);
  }
}

/** Builds a fixed-destination reclaim only after an ownership-scoped finalized projection read. */
export class AttendeeReclaimService {
  readonly #pool: Pool;
  readonly #journal: JournalPort;
  readonly #events: FinancialEventManifest["events"];
  readonly #now: () => Date;

  constructor(input: {
    pool: Pool;
    journal: JournalPort;
    manifest: FinancialEventManifest;
    now?: () => Date;
  }) {
    this.#pool = input.pool;
    this.#journal = input.journal;
    this.#events = input.manifest.events;
    this.#now = input.now ?? (() => new Date());
  }

  async accept(input: {
    identity: AccountIdentity;
    eventId: Hex;
    channelId: Hex;
    idempotencyKey: string;
  }) {
    const event = this.#events.find(
      (candidate) => candidate.eventId === input.eventId.toLowerCase(),
    );
    if (!event) throw new AttendeeReclaimRejected("channel_not_found");
    const projected = await this.#pool.query<{
      submit_until: string;
      reclaimed: boolean;
    }>(
      `SELECT ch.submit_until::text,ch.reclaimed
       FROM channel_projections ch
       JOIN finalized_chain_logs l ON l.transition_id=ch.opened_transition_id
       WHERE ch.channel_id=$1 AND ch.original_account=$2 AND l.event_id=$3
       LIMIT 2`,
      [input.channelId.toLowerCase(), input.identity.account.toLowerCase(), event.eventId],
    );
    if (projected.rowCount !== 1) throw new AttendeeReclaimRejected("channel_not_found");
    const row = projected.rows[0];
    if (!row) throw new AttendeeReclaimRejected("channel_not_found");
    if (row.reclaimed) throw new AttendeeReclaimRejected("channel_already_reclaimed");
    const now = this.#now();
    if (BigInt(row.submit_until) > BigInt(Math.floor(now.getTime() / 1_000)))
      throw new AttendeeReclaimRejected("reclaim_not_yet_eligible");
    const calldata = encodeFunctionData({
      abi: resilienceVaultAbi,
      functionName: "reclaim",
      args: [input.channelId],
    });
    const accepted = await this.#journal.accept({
      actorId: `attendee:${input.identity.account.toLowerCase()}`,
      kind: "RESERVE_RECLAIM",
      idempotencyKey: input.idempotencyKey,
      commandDigest: keccak256(calldata),
      aggregateId: input.channelId,
      targetAddress: event.vault,
      calldata,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
    });
    return {
      created: accepted.created,
      operationId: accepted.operation.operationId,
      kind: accepted.operation.kind,
      aggregateId: accepted.operation.aggregateId,
      state: accepted.operation.state,
      statusUrl: `/v1/financial-operations/${accepted.operation.operationId}`,
    };
  }
}
