import { money } from "../../lib/format";

export type ReserveBalance = {
  channelId: `0x${string}`;
  eventId: `0x${string}`;
  vendorId: `0x${string}`;
  status: "ACTIVE" | "RECLAIMED";
  reserveUnits: string;
  spentUnits: string;
  returnedUnits: string;
  remainingUnits: string;
  acceptUntil: string;
  submitUntil: string;
};

export type ReturnOperation = {
  operationId: string;
  state: string;
  transactionHash: string | null;
};

type Phase =
  | { kind: "returned"; units: string }
  | { kind: "spent" }
  | { kind: "spendable"; until: number; backFrom: number }
  | { kind: "settling"; backFrom: number }
  | { kind: "due" };

/**
 * Where one offline balance stands, in the attendee's terms. The deadlines are fixed on chain when
 * the balance is set aside, so this needs no service: before acceptUntil it can be spent, until
 * submitUntil vendors may still settle offline sales, and after that whatever is left belongs back
 * in the account.
 */
export function reservePhase(reserve: ReserveBalance, nowSeconds: number): Phase {
  if (reserve.status === "RECLAIMED") return { kind: "returned", units: reserve.returnedUnits };
  if (BigInt(reserve.remainingUnits) === 0n) return { kind: "spent" };
  const acceptUntil = Number(reserve.acceptUntil);
  const submitUntil = Number(reserve.submitUntil);
  if (nowSeconds < acceptUntil)
    return { kind: "spendable", until: acceptUntil, backFrom: submitUntil };
  if (nowSeconds < submitUntil) return { kind: "settling", backFrom: submitUntil };
  return { kind: "due" };
}

const amount = (units: string) => money(units);

function time(epochSeconds: number) {
  return new Date(epochSeconds * 1_000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 12 min", "in 2 h 5 min"; coarse on purpose, the exact time sits next to it. */
function relative(epochSeconds: number, nowSeconds: number) {
  const minutes = Math.max(1, Math.ceil((epochSeconds - nowSeconds) / 60));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

export function ReserveBalances({
  reserves,
  vendors,
  operations,
  nowSeconds,
  busy,
  onReturn,
}: {
  reserves: ReserveBalance[];
  vendors: Map<string, string>;
  operations: Record<string, ReturnOperation>;
  nowSeconds: number;
  busy: boolean;
  onReturn: (reserve: ReserveBalance) => void;
}) {
  if (reserves.length === 0)
    return (
      <p className="empty-state">
        Nothing set aside yet. Set aside a small amount above to pay a stall when the network drops.
      </p>
    );
  return (
    <ol className="activity-list">
      {reserves.map((reserve) => {
        const phase = reservePhase(reserve, nowSeconds);
        const operation = operations[reserve.channelId];
        const vendor = vendors.get(reserve.vendorId?.toLowerCase() ?? "") ?? "Stall";
        return (
          <li key={reserve.channelId} className="reserve-readback" data-phase={phase.kind}>
            <span className="reserve-title">
              <b>{vendor}</b>
              <em>
                {phase.kind === "returned"
                  ? "Returned"
                  : phase.kind === "spent"
                    ? "Fully spent"
                    : phase.kind === "spendable"
                      ? "Spendable offline"
                      : phase.kind === "settling"
                        ? "Closed for spending"
                        : "Ready to come back"}
              </em>
            </span>
            <strong>
              {phase.kind === "returned" ? amount(phase.units) : amount(reserve.remainingUnits)}{" "}
              {phase.kind === "returned" ? "back in your account" : "left"}
            </strong>
            <small>
              {phase.kind === "returned" && "Your unspent money was paid back to your account."}
              {phase.kind === "spent" && `You spent all ${amount(reserve.reserveUnits)}.`}
              {phase.kind === "spendable" &&
                `Spend it at the event until ${time(phase.until)}. Whatever is left comes back to you from ${time(phase.backFrom)} (${relative(phase.backFrom, nowSeconds)}).`}
              {phase.kind === "settling" &&
                `Vendors are finishing offline sales. What is left comes back to you from ${time(phase.backFrom)} (${relative(phase.backFrom, nowSeconds)}).`}
              {phase.kind === "due" && "It can only go back to your account."}
            </small>
            {phase.kind === "due" && (!operation || operation.state === "FAILED") && (
              <button type="button" disabled={busy} onClick={() => onReturn(reserve)}>
                Return {amount(reserve.remainingUnits)} now
              </button>
            )}
            {operation && phase.kind !== "returned" && (
              <small role="status">
                {operation.state === "FAILED"
                  ? "The return did not go through. Try again."
                  : "Return on its way. It shows here once the network confirms it."}
              </small>
            )}
          </li>
        );
      })}
    </ol>
  );
}
