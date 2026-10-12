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
 * One finalized transition in the attendee's words, short enough for one line on a phone. The
 * direction says whether money left the spendable balance or came back to it.
 */
function describe(item: ActivityItem, vendor: string) {
  switch (item.kind) {
    case "PAYMENT_COMMITTED":
      return { title: vendor, direction: "out" as const };
    case "VOUCHER_SETTLED":
      return { title: vendor, tag: "offline", direction: "out" as const };
    case "PAYMENT_CANCELLED":
      return { title: vendor, tag: "cancelled", direction: "none" as const };
    case "CHANNEL_OPENED":
      return { title: vendor, tag: "set aside", direction: "out" as const };
    case "CHANNEL_RECLAIMED":
      return { title: vendor, tag: "returned", direction: "in" as const };
    case "REFUND_COMMITTED":
      return { title: vendor, tag: "refund", direction: "in" as const };
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
        const { title, tag, direction } = describe(item, vendor);
        return (
          <li key={item.transitionId} data-direction={direction}>
            {/* The whole row opens the receipt, so there is no separate link to aim for. */}
            <a
              className="ledger-link"
              href={explorerTx(item.transactionHash)}
              target="_blank"
              rel="noreferrer"
              aria-label={`${title}${tag ? `, ${tag}` : ""}: open receipt`}
            >
              <div>
                <strong>
                  {title}
                  {tag && <span className="tag">{tag}</span>}
                </strong>
                <span>{when(new Date(item.recordedAt))}</span>
              </div>
              <div className="ledger-amount">
                {item.amountUnits !== null && (
                  <strong>
                    {direction === "in" ? "+" : direction === "out" ? "−" : ""}
                    {money(item.amountUnits)}
                  </strong>
                )}
              </div>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
