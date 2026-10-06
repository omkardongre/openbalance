import { resilienceVaultAbi } from "@openbalance/protocol";
import type { Pool } from "pg";
import { encodeFunctionData, type Hex, keccak256 } from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";
import {
  type FinancialOperation,
  FinancialOperationConflict,
  type FinancialOperationJournal,
} from "./financial-operations.js";

/**
 * Every sponsored reserve return runs under this one actor. `reclaim` always pays the channel's
 * original account, so the caller's identity cannot change the outcome and is not asked for: the
 * attendee, an independent verifier, a stranger or the scheduled workflow all reach the same command.
 */
export const RESERVE_RETURN_ACTOR = "reserve-return:public";

/** Upper bound on one listing, matching what one scheduled report may carry on chain. */
export const MAX_RECLAIMABLE_LISTING = 32;

const commandLifetimeMilliseconds = 10 * 60 * 1_000;

export type ReserveReclaimRejection =
  | "event_not_found"
  | "channel_not_found"
  | "channel_already_reclaimed"
  | "reclaim_not_yet_eligible"
  | "reclaim_not_found";

export class ReserveReclaimRejected extends Error {
  constructor(readonly code: ReserveReclaimRejection) {
    super(code);
  }
}

type JournalPort = Pick<FinancialOperationJournal, "accept" | "aggregateHistory">;

function present(operation: FinancialOperation, created: boolean) {
  return {
    created,
    operationId: operation.operationId,
    kind: operation.kind,
    aggregateId: operation.aggregateId,
    state: operation.state,
    transactionHash: operation.transaction?.hash ?? null,
    finalizedBlockNumber: operation.finalizedBlockNumber?.toString() ?? null,
    finalizedBlockHash: operation.finalizedBlockHash,
    failureCode: operation.failureCode,
    statusUrl: `/v1/reserve-channels/${operation.aggregateId}/reclaims`,
  };
}

/**
 * Sponsors `ResilienceVault.reclaim` for any channel the finalized projection shows past its
 * submission deadline and not yet returned. The vault enforces both rules again on chain, so this
 * gate only spares gas on commands that would revert. Each channel holds at most one live
 * operation; a fresh one is allowed only after the previous attempt ended FAILED.
 */
export class ReserveReclaimService {
  readonly #pool: Pool;
  readonly #journal: JournalPort;
  readonly #events: FinancialEventManifest["events"];
  readonly #chainSeconds: () => Promise<bigint>;
  readonly #now: () => Date;

  constructor(input: {
    pool: Pool;
    journal: JournalPort;
    manifest: FinancialEventManifest;
    /**
     * Settlement chain's block timestamp at the finalized tag. Eligibility is a contract rule over
     * `block.timestamp`, so it is never decided by this process's wall clock.
     */
    chainSeconds: () => Promise<bigint>;
    now?: () => Date;
  }) {
    this.#pool = input.pool;
    this.#journal = input.journal;
    this.#events = input.manifest.events;
    this.#chainSeconds = input.chainSeconds;
    this.#now = input.now ?? (() => new Date());
  }

  #event(eventId: Hex) {
    const event = this.#events.find((candidate) => candidate.eventId === eventId.toLowerCase());
    if (!event) throw new ReserveReclaimRejected("event_not_found");
    return event;
  }

  async accept(input: { eventId: Hex; channelId: Hex }) {
    const event = this.#event(input.eventId);
    const channelId = input.channelId.toLowerCase() as Hex;
    const projected = await this.#pool.query<{ submit_until: string; reclaimed: boolean }>(
      `SELECT ch.submit_until::text,ch.reclaimed
       FROM channel_projections ch
       JOIN finalized_chain_logs l ON l.transition_id=ch.opened_transition_id
       WHERE ch.channel_id=$1 AND l.event_id=$2
       LIMIT 2`,
      [channelId, event.eventId],
    );
    const row = projected.rows[0];
    if (projected.rowCount !== 1 || !row) throw new ReserveReclaimRejected("channel_not_found");
    if (row.reclaimed) throw new ReserveReclaimRejected("channel_already_reclaimed");
    if (BigInt(row.submit_until) > (await this.#chainSeconds()))
      throw new ReserveReclaimRejected("reclaim_not_yet_eligible");

    const history = await this.#journal.aggregateHistory(
      RESERVE_RETURN_ACTOR,
      "RESERVE_RECLAIM",
      channelId,
    );
    if (history.latest && history.latest.state !== "FAILED") return present(history.latest, false);

    const calldata = encodeFunctionData({
      abi: resilienceVaultAbi,
      functionName: "reclaim",
      args: [channelId],
    });
    try {
      const accepted = await this.#journal.accept({
        actorId: RESERVE_RETURN_ACTOR,
        kind: "RESERVE_RECLAIM",
        // One key per attempt generation, so concurrent requests for the same channel collide on
        // the unique index instead of queueing two commands.
        idempotencyKey: `reclaim:${channelId}:${history.failed}`,
        commandDigest: keccak256(calldata),
        aggregateId: channelId,
        targetAddress: event.vault,
        calldata,
        expiresAt: new Date(this.#now().getTime() + commandLifetimeMilliseconds),
      });
      return present(accepted.operation, accepted.created);
    } catch (error) {
      if (!(error instanceof FinancialOperationConflict)) throw error;
      const winner = await this.#journal.aggregateHistory(
        RESERVE_RETURN_ACTOR,
        "RESERVE_RECLAIM",
        channelId,
      );
      if (!winner.latest || winner.latest.state === "FAILED") throw error;
      return present(winner.latest, false);
    }
  }

  async status(channelId: Hex) {
    const history = await this.#journal.aggregateHistory(
      RESERVE_RETURN_ACTOR,
      "RESERVE_RECLAIM",
      channelId.toLowerCase() as Hex,
    );
    if (!history.latest) throw new ReserveReclaimRejected("reclaim_not_found");
    return present(history.latest, false);
  }

  /**
   * Channels whose reserve can be returned now and still holds money to return, oldest deadline
   * first. Read from the finalized projection; a scheduled caller re-verifies each one on chain.
   */
  async reclaimable(eventId: Hex, limit: number) {
    const event = this.#event(eventId);
    const chainTime = await this.#chainSeconds();
    const result = await this.#pool.query<{
      channel_id: string;
      submit_until: string;
      returnable_units: string;
    }>(
      `SELECT ch.channel_id,ch.submit_until::text,(ch.reserve_units-ch.spent_units)::text AS returnable_units
       FROM channel_projections ch
       JOIN finalized_chain_logs l ON l.transition_id=ch.opened_transition_id
       WHERE l.event_id=$1 AND ch.reclaimed=false AND ch.submit_until<=$2
         AND ch.reserve_units>ch.spent_units
       ORDER BY ch.submit_until,ch.channel_id
       LIMIT $3`,
      [event.eventId, chainTime.toString(), Math.min(Math.max(limit, 1), MAX_RECLAIMABLE_LISTING)],
    );
    return {
      eventId: event.eventId,
      vault: event.vault,
      chainTime: chainTime.toString(),
      channels: result.rows.map((row) => ({
        channelId: row.channel_id as Hex,
        submitUntil: row.submit_until,
        returnableUnits: row.returnable_units,
      })),
    };
  }
}
