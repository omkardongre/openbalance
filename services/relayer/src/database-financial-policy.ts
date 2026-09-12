import {
  accountAbi,
  exactPayRouterAbi,
  resilienceVaultAbi,
  settlementLedgerAbi,
} from "@openbalance/protocol";
import type { Pool } from "pg";
import { getAbiItem, getAddress, keccak256, toFunctionSelector } from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";
import type { FinancialOperation } from "./financial-operations.js";
import {
  BoundedFinancialCommandPolicy,
  type FinancialCommandPolicy,
  type FinancialCommandProposal,
  PermanentFinancialOperationFailure,
} from "./financial-worker.js";
import { expectedFinancialEvent } from "./viem-financial-finality.js";

const selector = (abi: Parameters<typeof getAbiItem>[0]["abi"], name: string) => {
  const item = getAbiItem({ abi, name });
  if (item?.type !== "function") throw new Error(`Missing contract function: ${name}`);
  return toFunctionSelector(item);
};

const attendeeSelectors = {
  PAYMENT: new Set([selector(accountAbi, "pay"), selector(accountAbi, "payWithOnlineSession")]),
  CANCELLATION: new Set([selector(accountAbi, "cancelPayment")]),
  RESERVE_OPEN: new Set([selector(accountAbi, "openReserveChannel")]),
} as const;

/** Authorizes account targets from verified deployments and event contracts from the manifest. */
export class DatabaseFinancialCommandPolicy implements FinancialCommandPolicy {
  readonly chainId: number;
  readonly #pool: Pool;
  readonly #budget: BoundedFinancialCommandPolicy;
  readonly #directRules: Set<string>;
  readonly #manifest: FinancialEventManifest;

  constructor(input: {
    pool: Pool;
    manifest: FinancialEventManifest;
    maxGasLimit: bigint;
    maxFeePerGas: bigint;
    maxCost: bigint;
  }) {
    this.chainId = input.manifest.chainId;
    this.#pool = input.pool;
    this.#manifest = input.manifest;
    this.#directRules = new Set(
      input.manifest.events.flatMap((event) => [
        `REFUND:${event.router}:${selector(exactPayRouterAbi, "refund")}`,
        `RESERVE_RECLAIM:${event.vault}:${selector(resilienceVaultAbi, "reclaim")}`,
        `WITHDRAWAL:${event.ledger}:${selector(settlementLedgerAbi, "withdrawFor")}`,
      ]),
    );
    this.#budget = new BoundedFinancialCommandPolicy({
      chainId: input.manifest.chainId,
      rules: input.manifest.events.flatMap((event) => [
        {
          kind: "REFUND" as const,
          targetAddress: event.router,
          selector: selector(exactPayRouterAbi, "refund"),
        },
        {
          kind: "RESERVE_RECLAIM" as const,
          targetAddress: event.vault,
          selector: selector(resilienceVaultAbi, "reclaim"),
        },
        {
          kind: "WITHDRAWAL" as const,
          targetAddress: event.ledger,
          selector: selector(settlementLedgerAbi, "withdrawFor"),
        },
      ]),
      maxGasLimit: input.maxGasLimit,
      maxFeePerGas: input.maxFeePerGas,
      maxCost: input.maxCost,
    });
  }

  async assertCommand(operation: FinancialOperation): Promise<void> {
    const callSelector = operation.calldata.slice(0, 10).toLowerCase();
    if (keccak256(operation.calldata).toLowerCase() !== operation.commandDigest.toLowerCase())
      throw new PermanentFinancialOperationFailure("command_digest_mismatch");
    const expected = expectedFinancialEvent(operation);
    if (
      operation.kind === "PAYMENT" ||
      operation.kind === "CANCELLATION" ||
      operation.kind === "RESERVE_OPEN"
    ) {
      if (
        !attendeeSelectors[operation.kind].has(callSelector as never) ||
        operation.actorId !== `attendee:${operation.targetAddress.toLowerCase()}`
      )
        throw new PermanentFinancialOperationFailure("command_not_sponsored");
      const event = this.#manifest.events.find(
        (candidate) =>
          candidate.eventId.toLowerCase() === expected.eventId?.toLowerCase() &&
          candidate.asset === expected.asset &&
          (candidate.router === expected.address || candidate.vault === expected.address),
      );
      if (!event) throw new PermanentFinancialOperationFailure("event_not_sponsored");
      const result = await this.#pool.query(
        `SELECT 1 FROM account_deployments
         WHERE account_address=$1 AND verified_block IS NOT NULL LIMIT 1`,
        [getAddress(operation.targetAddress)],
      );
      if (result.rowCount !== 1)
        throw new PermanentFinancialOperationFailure("account_not_verified");
      return;
    }
    const requiredActor = operation.kind === "RESERVE_RECLAIM" ? "attendee:" : "vendor-treasury:";
    if (!operation.actorId.startsWith(requiredActor))
      throw new PermanentFinancialOperationFailure("actor_not_sponsored");
    if (
      operation.kind === "REFUND" &&
      !this.#manifest.events.some(
        (event) =>
          event.router === getAddress(operation.targetAddress) &&
          event.eventId.toLowerCase() === expected.eventId?.toLowerCase() &&
          event.asset === expected.asset,
      )
    )
      throw new PermanentFinancialOperationFailure("event_not_sponsored");
    const key = `${operation.kind}:${getAddress(operation.targetAddress)}:${callSelector}`;
    if (!this.#directRules.has(key))
      throw new PermanentFinancialOperationFailure("command_not_sponsored");
  }

  assertProposal(operation: FinancialOperation, proposal: FinancialCommandProposal): void {
    this.#budget.assertProposal(operation, proposal);
  }
}
