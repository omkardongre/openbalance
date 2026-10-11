"use client";

import { type ReserveChannelConfig, resilienceVaultAbi } from "@openbalance/protocol";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseUnits,
} from "viem";
import { passkeyErrorMessage } from "../../lib/account-display";
import {
  financialIdempotencyKey,
  type PasskeyIdentity,
  reserveCommand,
} from "../../lib/financial-client";
import {
  activateOfflineChannel,
  createOfflineChannelKey,
  stageOfflineChannel,
} from "../../lib/offline-wallet";
import { loadReserveTerms, type ReserveTerms, type Stall } from "../../lib/reserve-terms";

/** Quick amounts offered when the stall allows them; larger ones are hidden, not refused later. */
const QUICK_AMOUNTS = ["1", "2", "5"];

type Choice = { event: ReserveTerms["events"][number]; stall: Stall };

type Operation = { operationId: string; state: string; transactionHash: string | null };

const TERMINAL_STATES = ["FINALIZED", "FAILED", "QUARANTINED"];

/** Covers passkey approval plus sponsored submission; the reserve is spendable after this lead. */
const RESERVE_START_LEAD_SECONDS = 60;

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error?.replaceAll("_", " ") ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

/**
 * Opens an outage reserve for one stall from the attendee's own device, the way festival apps let
 * people top up before arriving. No stall action is needed: the vault resolves the terminal and
 * payout destinations from the event registry, and the attendee's passkey approves the exact terms.
 */
export function OpenReserve(props: {
  identity: PasskeyIdentity;
  disabled: boolean;
  onOpened: (channelId: Hex) => Promise<void>;
}) {
  const relayer = process.env.NEXT_PUBLIC_RELAYER_URL;
  const [choices, setChoices] = useState<Choice[]>([]);
  const [chainId, setChainId] = useState<number>();
  const [selected, setSelected] = useState(0);
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<"info" | "success" | "error">("info");
  const [pending, setPending] = useState<{ channelId: Hex; operation: Operation }>();

  function say(text: string, nextTone: "info" | "success" | "error" = "info") {
    setMessage(text);
    setTone(nextTone);
  }

  useEffect(() => {
    loadReserveTerms()
      .then((terms: ReserveTerms) => {
        setChainId(terms.chainId);
        setChoices(
          terms.events.flatMap((event) =>
            event.vendors
              .filter((stall) => stall.listed !== false)
              .map((stall) => ({ event, stall })),
          ),
        );
      })
      .catch(() => {
        setMessage("Stalls are unavailable right now. Try again in a moment.");
        setTone("error");
      });
  }, []);

  const choice = choices[selected];
  const amounts = choice
    ? QUICK_AMOUNTS.filter(
        (value) =>
          parseUnits(value, choice.event.assetDecimals) <=
          BigInt(choice.stall.reservePolicy.maximumReserveUnits),
      )
    : QUICK_AMOUNTS;
  // The chosen amount stays valid when the stall (and so its maximum) changes.
  const chosen = amounts.includes(amount) ? amount : (amounts[0] ?? amount);

  // Follow the open until the network finalizes it, then make it spendable offline on this device.
  useEffect(() => {
    if (!pending || TERMINAL_STATES.includes(pending.operation.state) || !relayer) return;
    const timer = setTimeout(async () => {
      try {
        const next = await json<Operation>(
          `${relayer}/v1/financial-operations/${encodeURIComponent(pending.operation.operationId)}`,
          { headers: { Authorization: `Bearer ${props.identity.sessionToken}` } },
        );
        setPending({ ...pending, operation: next });
        if (next.state === "FINALIZED") {
          await activateOfflineChannel(pending.channelId);
          await props.onOpened(pending.channelId);
          say("Reserve ready. You can pay at this stall even with no network.", "success");
        } else if (TERMINAL_STATES.includes(next.state)) {
          say("The reserve did not open. Your balance is unchanged.", "error");
        }
      } catch {
        // A transient status failure keeps the open in place; the next tick asks again.
      }
    }, 3_000);
    return () => clearTimeout(timer);
  });

  async function open() {
    if (!choice || !relayer || chainId === undefined) return;
    setBusy(true);
    say("");
    try {
      const { event, stall } = choice;
      const reserveUnits = parseUnits(chosen, event.assetDecimals);
      const maximum = BigInt(stall.reservePolicy.maximumReserveUnits);
      if (reserveUnits < 1n || reserveUnits > maximum)
        throw new Error(
          `Choose an amount up to ${Number(maximum) / 10 ** event.assetDecimals} ${event.assetSymbol}.`,
        );
      const account = getAddress(props.identity.account);
      const key = await createOfflineChannelKey();
      const signer = getAddress(key.signer);
      const channelId = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "address" }],
          [event.eventId, account, stall.terminal.instanceId, signer],
        ),
      );
      const perSale = BigInt(stall.reservePolicy.maximumPerVoucherUnits);
      const rpcUrl = process.env.NEXT_PUBLIC_FINANCIAL_RPC_URL;
      if (!rpcUrl) throw new Error("Financial RPC is not configured.");
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
      // The registry requires acceptFrom to still be in the future when the open executes, so the
      // window starts a short lead after the chain's own clock (never the phone's).
      const now = Number((await client.getBlock({ blockTag: "latest" })).timestamp);
      const acceptFrom = now + RESERVE_START_LEAD_SECONDS;
      const acceptUntil = acceptFrom + stall.reservePolicy.acceptanceDurationSeconds;
      const config: ReserveChannelConfig = {
        channelId,
        eventId: event.eventId,
        asset: getAddress(event.asset),
        reserveUnits,
        vendorId: stall.vendorId,
        vendorDestinationVersion: BigInt(stall.destinationVersion),
        terminalInstanceId: stall.terminal.instanceId,
        terminalKeyVersion: BigInt(stall.terminal.keyVersion),
        attendeeChannelSigner: signer,
        configVersion: BigInt(event.configVersion),
        organizerFeeBps: event.organizerFeeBps,
        platformFeeBps: event.platformFeeBps,
        maxPerVoucher: reserveUnits < perSale ? reserveUnits : perSale,
        maxVoucherCount: stall.reservePolicy.maximumVoucherCount,
        acceptFrom,
        acceptUntil,
        submitUntil: acceptUntil + stall.reservePolicy.submissionDelaySeconds,
        genesisDigest: keccak256(
          encodeAbiParameters(
            [{ type: "string" }, { type: "bytes32" }],
            ["openbalance:reserve-genesis:v1", channelId],
          ),
        ),
      };
      // Ask the vault itself whether these terms are valid before the passkey prompt, so a stale
      // stall listing fails here with a clear message instead of as a reverted transaction.
      if ((await client.getChainId()) !== chainId)
        throw new Error("The configured network does not match the event.");
      await client
        .readContract({
          address: getAddress(event.vault),
          abi: resilienceVaultAbi,
          functionName: "quoteChannel",
          args: [config],
          account,
        })
        .catch(() => {
          throw new Error("This stall is not accepting reserves right now.");
        });
      const idempotencyKey = financialIdempotencyKey("RESERVE_OPEN", channelId);
      await stageOfflineChannel({
        keyId: key.keyId,
        signer,
        chainId: BigInt(chainId),
        vault: getAddress(event.vault),
        terminalSigner: getAddress(stall.terminal.signer),
        config,
        operationId: idempotencyKey,
        display: {
          vendorName: stall.vendorName,
          assetSymbol: event.assetSymbol,
          assetDecimals: event.assetDecimals,
        },
      });
      const calldata = await reserveCommand({
        identity: { ...props.identity, account },
        chainId: BigInt(chainId),
        vault: getAddress(event.vault),
        config,
        maximumTotalReserve: maximum,
        deadline: BigInt(Math.min(acceptUntil, now + 300)),
      });
      const operation = await json<Operation>(`${relayer}/v1/accounts/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${props.identity.sessionToken}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ kind: "RESERVE_OPEN", calldata }),
      });
      setPending({ channelId, operation });
      say("Setting aside your reserve. This takes a few seconds.");
    } catch (error) {
      say(
        passkeyErrorMessage(error, "The reserve could not be opened. Your balance is unchanged."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  const waiting = pending && !TERMINAL_STATES.includes(pending.operation.state);
  return (
    <section className="card" aria-labelledby="reserve-heading">
      <div className="section-heading">
        <h2 id="reserve-heading">Set aside for outages</h2>
        <p>Optional</p>
      </div>
      <p className="muted">
        Lock a small amount for one stall so you can still pay there if the network drops. Whatever
        you do not spend can be returned to you after about 90 minutes.
      </p>
      {choices.length > 1 && (
        <label>
          Stall
          <select
            value={selected}
            disabled={busy || Boolean(waiting)}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {choices.map((choice, index) => (
              <option key={`${choice.event.eventId}:${choice.stall.vendorId}`} value={index}>
                {choice.stall.vendorName}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset className="amount-row">
        <legend className="visually-hidden">Reserve amount</legend>
        {amounts.map((value) => (
          <button
            key={value}
            type="button"
            className="secondary-button"
            aria-pressed={chosen === value}
            disabled={busy || Boolean(waiting)}
            onClick={() => setAmount(value)}
          >
            {value} {choice?.event.assetSymbol ?? "USDC"}
          </button>
        ))}
      </fieldset>
      <button
        type="button"
        className="block-button"
        disabled={props.disabled || busy || Boolean(waiting) || !choice}
        onClick={open}
      >
        {busy || waiting
          ? "Setting aside…"
          : `Set aside ${chosen} ${choice?.event.assetSymbol ?? "USDC"}`}
      </button>
      <p role="status" aria-live="polite" className={`notice ${tone === "info" ? "" : tone}`}>
        {message}
      </p>
      {tone === "success" && (
        <Link className="secondary-action block-button" href="/offline">
          Go to Pay offline
        </Link>
      )}
    </section>
  );
}
