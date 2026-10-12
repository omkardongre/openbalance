"use client";

import { useState } from "react";
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

/** Reserves listed before the customer asks for more. */
const RESERVE_PREVIEW = 3;

/** Reserves that still hold money, soonest deadline first: what "Your offline money" counts. */
export function currentReserves(reserves: ReserveBalance[], nowSeconds: number) {
  return reserves
    .filter((reserve) => {
      const kind = reservePhase(reserve, nowSeconds).kind;
      return kind !== "returned" && kind !== "spent";
    })
    .sort((left, right) => Number(left.acceptUntil) - Number(right.acceptUntil));
}

export function ReserveBalances({
  reserves,
  vendors,
  operations,
  nowSeconds,
  busy,
  returning,
  onReturn,
}: {
  reserves: ReserveBalance[];
  vendors: Map<string, string>;
  operations: Record<string, ReturnOperation>;
  nowSeconds: number;
  busy: boolean;
  returning?: string | undefined;
  onReturn: (reserve: ReserveBalance) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Only money that still needs the customer: spendable, closing, or ready to come back. Returned
  // and fully spent reserves are finished and already listed in Recent payments.
  const current = currentReserves(reserves, nowSeconds);
  if (current.length === 0) return null;
  const shown = expanded ? current : current.slice(0, RESERVE_PREVIEW);
  return (
    <details className="offline-money">
      <summary>Your offline money · {current.length}</summary>
      <ol className="activity-list ledger reserve-list">
        {shown.map((reserve) => {
          const phase = reservePhase(reserve, nowSeconds);
          const operation = operations[reserve.channelId];
          const vendor = vendors.get(reserve.vendorId?.toLowerCase() ?? "") ?? "a stall";
          // One line per reserve: whose it is, how much is left, and the one time that matters now.
          const detail =
            phase.kind === "spendable"
              ? `Spend until ${time(phase.until)}`
              : phase.kind === "settling"
                ? `Back from ${time(phase.backFrom)}`
                : "Ready to come back";
          return (
            <li key={reserve.channelId} data-phase={phase.kind}>
              <div className="ledger-row">
                <span className="stall-avatar" aria-hidden="true">
                  {vendor.charAt(0).toUpperCase()}
                </span>
                <span className="stall-text">
                  <strong>{vendor}</strong>
                  <span>{detail}</span>
                </span>
                <strong className="stall-amount">{amount(reserve.remainingUnits)}</strong>
              </div>
              {phase.kind === "settling" && (
                <small>
                  Stalls are finishing offline sales. The rest comes back{" "}
                  {relative(phase.backFrom, nowSeconds)}.
                </small>
              )}
              {phase.kind === "due" && (!operation || operation.state === "FAILED") && (
                <button
                  type="button"
                  className="secondary-button block-button"
                  disabled={busy || returning === reserve.channelId}
                  aria-busy={returning === reserve.channelId}
                  onClick={() => onReturn(reserve)}
                >
                  {returning === reserve.channelId
                    ? "Returning…"
                    : `Return ${amount(reserve.remainingUnits)} now`}
                </button>
              )}
              {operation && (
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
      {current.length > RESERVE_PREVIEW && (
        <button
          type="button"
          className="text-button show-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show more (${current.length - RESERVE_PREVIEW})`}
        </button>
      )}
    </details>
  );
}
