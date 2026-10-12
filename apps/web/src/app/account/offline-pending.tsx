"use client";

import type { AttendeeChannelState } from "@openbalance/attendee";
import { useEffect, useState } from "react";
import { money, when } from "../../lib/format";
import { readSettlementStatuses, type SettlementStatus } from "../../lib/offline-settlement";
import {
  listOfflineAuthorizations,
  listOfflineChannels,
  type StoredAuthorization,
} from "../../lib/offline-wallet";

const POLL_MS = 10_000;

/**
 * Payments this phone approved without signal that the network has not confirmed yet. Once one
 * settles it shows in Activity like any other payment, so only the open ones are listed here.
 */
export function OfflinePending({ online }: { online: boolean }) {
  const [channels, setChannels] = useState<AttendeeChannelState[]>([]);
  const [authorizations, setAuthorizations] = useState<StoredAuthorization[]>([]);
  const [statuses, setStatuses] = useState<Map<string, SettlementStatus>>();

  useEffect(() => {
    void Promise.all([listOfflineChannels(), listOfflineAuthorizations()])
      .then(([nextChannels, nextAuthorizations]) => {
        setChannels(nextChannels);
        setAuthorizations(nextAuthorizations.filter((item) => !item.supersededBy));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!online || authorizations.length === 0) return;
    let active = true;
    const check = () =>
      readSettlementStatuses(channels, authorizations)
        .then((next) => {
          if (active) setStatuses(next);
        })
        .catch(() => undefined);
    void check();
    const timer = window.setInterval(check, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [online, channels, authorizations]);

  // Until the first check answers, nothing is listed, so settled payments never flash up here.
  const open =
    online && !statuses
      ? []
      : authorizations
          .filter((item) => {
            const status = statuses?.get(item.paymentId);
            return status !== "SETTLED" && status !== "RETURNED" && status !== "MISSED";
          })
          .sort((left, right) => right.createdAt - left.createdAt);
  if (open.length === 0) return null;
  const byChannel = new Map(channels.map((channel) => [channel.channelId.toLowerCase(), channel]));

  return (
    <ol className="activity-list ledger" aria-label="Paid without signal, confirming">
      {open.map((item) => {
        const owner = byChannel.get(item.channelId.toLowerCase());
        const asset = owner
          ? { symbol: owner.display.assetSymbol, decimals: owner.display.assetDecimals }
          : undefined;
        return (
          <li key={item.paymentId} data-direction="out">
            <div>
              <strong>
                {owner?.display.vendorName ?? "Stall"}
                <span className="tag">offline</span>
              </strong>
              <span>{when(item.createdAt)}</span>
            </div>
            <div className="ledger-amount">
              <strong>−{money(item.grossUnits, asset)}</strong>
              <span className="chip" data-tone="wait">
                Confirming
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
