import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";

export type Stall = {
  vendorId: Hex;
  vendorName: string;
  /** False for a retired stall: kept so history can name it, but not offered for new reserves. */
  listed?: boolean;
  destinationVersion: string;
  terminal: { instanceId: Hex; keyVersion: string; signer: Address };
  reservePolicy: {
    maximumReserveUnits: string;
    maximumPerVoucherUnits: string;
    maximumVoucherCount: number;
    acceptanceDurationSeconds: number;
    submissionDelaySeconds: number;
  };
};

export type ReserveTerms = {
  schemaVersion: 1;
  chainId: number;
  events: {
    eventId: Hex;
    vault: Address;
    asset: Address;
    assetSymbol: string;
    assetDecimals: number;
    configVersion: string;
    organizerFeeBps: number;
    platformFeeBps: number;
    vendors: Stall[];
  }[];
};

let pending: Promise<ReserveTerms> | undefined;

/**
 * The public stall listing, fetched once per page load. Every attendee view names stalls from it,
 * so a row reads "Merch stand" rather than a vendor identifier.
 */
export function loadReserveTerms(): Promise<ReserveTerms> {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) return Promise.reject(new Error("Account service is not configured."));
  pending ??= fetch(`${api}/v1/reserve-terms`, { signal: AbortSignal.timeout(30_000) }).then(
    async (response) => {
      if (!response.ok) throw new Error("Stalls are unavailable right now.");
      return (await response.json()) as ReserveTerms;
    },
  );
  // A failed load is not cached, so the next view retries.
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}

/**
 * The stall listing for a component, retried whenever the browser comes back online. A page opened
 * with no signal (the saved offline copy) would otherwise never learn the stall names once the
 * phone reconnects, and every row would read "a stall".
 */
export function useReserveTerms(): { terms: ReserveTerms | undefined; failed: boolean } {
  const [terms, setTerms] = useState<ReserveTerms>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      loadReserveTerms()
        .then((next) => {
          if (!active) return;
          setTerms(next);
          setFailed(false);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    void load();
    window.addEventListener("online", load);
    return () => {
      active = false;
      window.removeEventListener("online", load);
    };
  }, []);
  return { terms, failed: failed && !terms };
}

/** Vendor id (lowercase) → stall name; empty until the listing loads. */
export function useVendorNames() {
  const { terms } = useReserveTerms();
  return useMemo(
    () =>
      new Map(
        (terms?.events ?? []).flatMap((event) =>
          event.vendors.map((stall) => [stall.vendorId.toLowerCase(), stall.vendorName] as const),
        ),
      ),
    [terms],
  );
}
