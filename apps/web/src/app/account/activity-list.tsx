import { explorerTx, money, when } from "../../lib/format";

export type ActivityItem = {
  transitionId: string;
  kind: string;
  aggregateKind: "PAYMENT" | "CHANNEL";
  aggregateId: string;
  transactionHash: string;
  blockNumber: string;
  eventId: string;
  amountUnits: string | null;
  vendorId: string | null;
  recordedAt: string;
};

/**
 * One finalized transition in the attendee's words. The direction says whether money left the
 * spendable balance (a payment or a reserve) or came back to it (a return or a refund).
 */
function describe(item: ActivityItem, vendor: string) {
  switch (item.kind) {
    case "PAYMENT_COMMITTED":
      return { title: `Paid ${vendor}`, direction: "out" as const };
    case "VOUCHER_SETTLED":
      return { title: `Paid ${vendor} offline`, direction: "out" as const };
    case "PAYMENT_CANCELLED":
      return { title: `Payment to ${vendor} cancelled`, direction: "none" as const };
    case "CHANNEL_OPENED":
      return { title: `Set aside for ${vendor}`, direction: "out" as const };
    case "CHANNEL_RECLAIMED":
      return { title: `Unspent reserve returned from ${vendor}`, direction: "in" as const };
    case "REFUND_COMMITTED":
      return { title: `Refund from ${vendor}`, direction: "in" as const };
    default:
      return {
        title: item.kind.charAt(0) + item.kind.slice(1).toLowerCase().replaceAll("_", " "),
        direction: "none" as const,
      };
  }
}

export function ActivityList({
  items,
  vendors,
}: {
  items: ActivityItem[];
  vendors: Map<string, string>;
}) {
  if (items.length === 0)
    return <p className="empty-state">No payments yet. They appear here once confirmed.</p>;
  return (
    <ol className="activity-list ledger">
      {items.map((item) => {
        const vendor = (item.vendorId && vendors.get(item.vendorId.toLowerCase())) ?? "a stall";
        const { title, direction } = describe(item, vendor);
        return (
          <li key={item.transitionId} data-direction={direction}>
            <div>
              <strong>{title}</strong>
              <span>{when(new Date(item.recordedAt))}</span>
            </div>
            <div className="ledger-amount">
              {item.amountUnits !== null && (
                <strong>
                  {direction === "in" ? "+" : direction === "out" ? "−" : ""}
                  {money(item.amountUnits)}
                </strong>
              )}
              <a href={explorerTx(item.transactionHash)} target="_blank" rel="noreferrer">
                Receipt
              </a>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
