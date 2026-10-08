import type { AttendeeChannelState } from "@openbalance/attendee";
import { resilienceVaultAbi } from "@openbalance/protocol";
import { createPublicClient, http } from "viem";
import type { StoredAuthorization } from "./offline-wallet";

/**
 * SETTLED: paid to the vendor in a finalized block. MISSED: the upload deadline passed unsettled,
 * so it can never settle and comes back to the attendee. RETURNED: the reserve has been returned.
 */
export type SettlementStatus = "SETTLED" | "MISSED" | "RETURNED" | "PENDING";

type ChannelSettlement = { spentGross: bigint; reclaimed: boolean; finalizedAt: number };

/**
 * Reads each reserve's settled total from the vault at the finalized block. Monad's `latest` tag
 * returns the proposed block, so a payment is only called settled once it is in a finalized one.
 * The read goes straight to the public RPC: the receipt never depends on our own services.
 */
async function readChannelSettlements(
  channels: AttendeeChannelState[],
): Promise<Map<string, ChannelSettlement>> {
  const rpcUrl = process.env.NEXT_PUBLIC_FINANCIAL_RPC_URL;
  const result = new Map<string, ChannelSettlement>();
  if (!rpcUrl || channels.length === 0) return result;
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: "finalized" }),
  ]);
  await Promise.all(
    channels
      .filter((channel) => channel.chainId === BigInt(chainId))
      .map(async (channel) => {
        const [, spentGross, , , reclaimed] = await client.readContract({
          address: channel.vault,
          abi: resilienceVaultAbi,
          functionName: "channelState",
          args: [channel.channelId],
          blockNumber: block.number,
        });
        result.set(channel.channelId, {
          spentGross,
          reclaimed,
          finalizedAt: Number(block.timestamp),
        });
      }),
  );
  return result;
}

/**
 * Settlement status per authorization. Vouchers settle strictly in sequence with a running total,
 * so once the vault's finalized `spentGross` reaches this voucher's cumulative total, this voucher
 * has settled. Past the upload deadline, an unsettled voucher can never settle and its amount goes
 * back to the attendee.
 */
export async function readSettlementStatuses(
  channels: AttendeeChannelState[],
  authorizations: StoredAuthorization[],
): Promise<Map<string, SettlementStatus>> {
  const settlements = await readChannelSettlements(channels);
  const deadlines = new Map(channels.map((channel) => [channel.channelId, channel.submitUntil]));
  const statuses = new Map<string, SettlementStatus>();
  for (const authorization of authorizations) {
    if (authorization.supersededBy) continue;
    const settlement = settlements.get(authorization.channelId);
    const submitUntil = deadlines.get(authorization.channelId);
    if (!settlement || submitUntil === undefined) continue;
    if (settlement.spentGross >= authorization.cumulativeGrossUnits)
      statuses.set(authorization.paymentId, "SETTLED");
    else if (settlement.reclaimed) statuses.set(authorization.paymentId, "RETURNED");
    else if (settlement.finalizedAt >= submitUntil) statuses.set(authorization.paymentId, "MISSED");
    else statuses.set(authorization.paymentId, "PENDING");
  }
  return statuses;
}
