"use client";

import QRCode from "qrcode";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import {
  retryAfterMs,
  runRegistryOperation,
  shortAddress,
  TOO_MANY_REQUESTS,
  TransientRequestError,
} from "../../lib/organizer-wallet";
import { loadReserveTerms } from "../../lib/reserve-terms";
import { terminalSetupPayload } from "../../lib/terminal-setup";
import { PhoneSetupSteps } from "../phone-setup-steps";

type StallState = "INVITED" | "SUBMITTED" | "DECLINED" | "APPROVED" | "LIVE";

type Stall = {
  stallId: string;
  label: string;
  state: StallState;
  stallName: string | null;
  category: string | null;
  vendorId: Hex;
  authority: `0x${string}` | null;
  payoutAddress: `0x${string}` | null;
  destinationVersion: string;
  destinationDeadline: string | null;
  vendorSignature: Hex | null;
  terminal: {
    instanceId: Hex;
    keyVersion: string;
    pendingSigner: `0x${string}` | null;
    pendingSeenAt: string | null;
    signer: `0x${string}` | null;
    /** Live on chain, but its phone has since been set up for another stall. */
    moved?: boolean;
  };
  setupCodeIssued: boolean;
  inviteExpiresAt: string;
  createdAt: string;
};

type Registry = {
  vendorRegistered: boolean;
  destinationRegistered: boolean;
  terminalRegistered: boolean;
  terminalWindow: { validAfter: number; validUntil: number };
  configOpen: boolean;
};

type Dialog =
  | { kind: "invite" }
  | { kind: "invite-link"; link: string; image: string; label: string }
  | { kind: "review"; stallId: string }
  | {
      kind: "pair";
      stallId: string;
      image?: string;
      moved?: boolean | undefined;
      /** The organizer approved the phone; close with a success note once the list shows it live. */
      awaitingLive?: boolean;
    };

type Props = {
  api: string;
  token: string;
  eventId: Hex;
  chainId: number;
};

const PAGE = 8;
/** Success notes fade on their own; errors stay until the next action. 5 s minimum for readers. */
const SUCCESS_MS = 6_000;
/** The list re-reads itself while the tab is visible, so an owner's submission shows up alone. */
const LIST_REFRESH_MS = 10_000;

type RowControl =
  | { kind: "chip"; label: string; tone: "ok" | "wait" | "muted" }
  | { kind: "button"; label: string; open: Dialog["kind"] };

/** Exactly one thing per row: a button when the organizer has something to do, else a status. */
function controlOf(stall: Stall): RowControl {
  switch (stall.state) {
    case "INVITED":
      return { kind: "chip", label: "Waiting for owner", tone: "wait" };
    case "SUBMITTED":
      return { kind: "button", label: "Review", open: "review" };
    case "APPROVED":
      return {
        kind: "button",
        label: stall.terminal.pendingSigner ? "Approve terminal" : "Pair terminal",
        open: "pair",
      };
    case "LIVE":
      return stall.terminal.moved
        ? { kind: "button", label: "Pair terminal", open: "pair" }
        : { kind: "chip", label: "Live", tone: "ok" };
    default:
      return { kind: "chip", label: "Declined", tone: "muted" };
  }
}

/** The line under the stall name. */
function detailOf(stall: Stall) {
  if (!stall.stallName) return "Invite sent";
  if (stall.state === "LIVE" && stall.terminal.moved)
    return `${stall.category ?? ""}${stall.category ? " · " : ""}Its phone now sells for another stall`;
  if (stall.state === "APPROVED" && stall.terminal.pendingSigner)
    return `${stall.category ?? ""}${stall.category ? " · " : ""}Phone checked in`;
  return stall.category ?? "";
}

/** WAI-ARIA menu button: rare actions stay one tap away without cluttering the row. */
function RowMenu(props: {
  label: string;
  disabled: boolean;
  items: { label: string; onSelect(): void }[];
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="row-menu" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="text-button row-menu-trigger"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: the ARIA menu pattern, not a native <menu>
        <div
          role="menu"
          tabIndex={-1}
          className="row-menu-list"
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") close();
          }}
        >
          {props.items.map((item, index) => (
            <button
              key={item.label}
              ref={index === 0 ? first : undefined}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Modal(props: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      onClose={props.onClose}
      onCancel={props.onClose}
    >
      <div className="modal-head">
        <h2 id="modal-title">{props.title}</h2>
        <button type="button" className="text-button" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {props.children}
    </dialog>
  );
}

export function StallsPanel({ api, token, eventId, chainId }: Props) {
  const [stalls, setStalls] = useState<Stall[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressNote, setProgressNote] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "info" | "success" | "error" }>();
  const [shown, setShown] = useState(PAGE);
  const [showDeclined, setShowDeclined] = useState(false);
  const base = `/v1/events/${encodeURIComponent(eventId)}/stalls`;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (message?.tone !== "success") return;
    const timer = setTimeout(() => setMessage(undefined), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const call = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body) headers.set("Content-Type", "application/json");
      const response = await fetch(`${api}${path}`, {
        ...init,
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429)
        throw new TransientRequestError(TOO_MANY_REQUESTS, retryAfterMs(response, 10_000));
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "registry_unavailable")
          throw new Error("The network is not answering right now. Try again in a moment.");
        if (body?.error === "stall_state_conflict")
          throw new Error("This stall changed in the meantime. The list has been refreshed.");
        throw new Error("That did not work. Try again.");
      }
      return (await response.json()) as T;
    },
    [api, token],
  );

  const load = useCallback(async () => {
    const list = await call<{ items: Stall[] }>(base);
    setStalls(list.items);
    setLoaded(true);
    return list.items;
  }, [base, call]);

  useEffect(() => {
    load().catch((error: unknown) =>
      setMessage({
        text: error instanceof Error ? error.message : "Stalls are unavailable.",
        tone: "error",
      }),
    );
    loadReserveTerms()
      .then((terms) =>
        setExisting(
          terms.events
            .filter((event) => event.eventId.toLowerCase() === eventId.toLowerCase())
            .flatMap((event) =>
              event.vendors
                .filter((vendor) => vendor.listed !== false)
                .map((vendor) => vendor.vendorName),
            ),
        ),
      )
      .catch(() => undefined);
  }, [eventId, load]);

  // Re-read the list every few seconds while the tab is visible, and right away on returning to it.
  // A rate-limited read pauses polling for as long as the server asks instead of adding to it.
  const pausedUntil = useRef(0);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() < pausedUntil.current) return;
      load().catch((error: unknown) => {
        if (error instanceof TransientRequestError)
          pausedUntil.current = Date.now() + error.retryAfterMs;
      });
    };
    const timer = setInterval(tick, LIST_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  async function refreshList() {
    setRefreshing(true);
    try {
      await load();
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Stalls are unavailable.",
        tone: "error",
      });
    } finally {
      setRefreshing(false);
    }
  }

  // The list poll also notices the phone checking in and the stall going live. Once an approved
  // phone shows live, the popup closes with a success note, even if a status check failed on the way.
  useEffect(() => {
    if (dialog?.kind !== "pair" || !dialog.awaitingLive) return;
    const stall = stalls.find((candidate) => candidate.stallId === dialog.stallId);
    if (stall?.state !== "LIVE") return;
    setDialog(undefined);
    setMessage({
      text: `${stall.stallName ?? stall.label} is live. Customers can now choose it.`,
      tone: "success",
    });
  }, [dialog, stalls]);

  async function step<T>(work: () => Promise<T>, success?: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await work();
      if (success) setMessage({ text: success, tone: "success" });
      return result;
    } catch (error) {
      const code = (error as { code?: number }).code;
      setMessage({
        text:
          code === 4001
            ? "You cancelled the request in your wallet. Nothing changed."
            : error instanceof Error
              ? error.message
              : "That did not work. Try again.",
        tone: "error",
      });
      await load().catch(() => undefined);
      return undefined;
    } finally {
      setBusy(false);
      setProgressNote("");
    }
  }

  async function createInvite() {
    const name = label.trim();
    if (!name) {
      setMessage({ text: "Give the invite a name you will recognise.", tone: "error" });
      return;
    }
    await step(async () => {
      const created = await call<{ stall: Stall; inviteToken: string }>(base, {
        method: "POST",
        body: JSON.stringify({ label: name }),
      });
      const link = `${window.location.origin}/stall/join#${created.inviteToken}`;
      const image = await QRCode.toDataURL(link, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 360,
      });
      setLabel("");
      setDialog({ kind: "invite-link", link, image, label: name });
      await load();
    });
  }

  async function refresh(stall: Stall) {
    return call<{ stall: Stall; registry: Registry | null }>(`${base}/${stall.stallId}/refresh`, {
      method: "POST",
      body: "{}",
    });
  }

  async function approve(stall: Stall) {
    await step(
      async () => {
        const operation = (step: string, body: Record<string, unknown>) =>
          runRegistryOperation({
            api,
            token,
            eventId,
            chainId,
            body,
            onProgress: (note) => setProgressNote(`${step}: ${note}`),
          });
        let checked = await refresh(stall);
        if (!checked.registry?.vendorRegistered) {
          await operation("Step 1 of 2", {
            kind: "VENDOR",
            vendorId: stall.vendorId,
            authority: stall.authority,
          });
        }
        checked = await refresh(stall);
        if (!checked.registry?.destinationRegistered) {
          await operation("Step 2 of 2", {
            kind: "DESTINATION",
            vendorId: stall.vendorId,
            version: stall.destinationVersion,
            destination: stall.payoutAddress,
            deadline: stall.destinationDeadline,
            vendorSignature: stall.vendorSignature,
          });
        }
        checked = await refresh(stall);
        await load();
        if (checked.stall.state !== "APPROVED")
          throw new Error(
            "The network has not confirmed it yet. Open the stall again in a minute.",
          );
        setDialog({ kind: "pair", stallId: stall.stallId });
      },
      `${stall.stallName ?? stall.label} is approved. Next, pair its terminal.`,
    );
  }

  async function decline(stall: Stall) {
    await step(async () => {
      await call(`${base}/${stall.stallId}/decline`, { method: "POST", body: "{}" });
      setDialog(undefined);
      await load();
    }, "Removed.");
  }

  async function setupCode(stall: Stall) {
    await step(async () => {
      const issued = await call<{ accessToken: string }>(`${base}/${stall.stallId}/setup-codes`, {
        method: "POST",
        body: "{}",
      });
      const image = await QRCode.toDataURL(terminalSetupPayload(issued.accessToken), {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 360,
      });
      setDialog((open) => ({
        kind: "pair",
        stallId: stall.stallId,
        image,
        moved: open?.kind === "pair" ? open.moved : undefined,
      }));
      await load();
    });
  }

  async function approveTerminal(stall: Stall) {
    setDialog((open) => (open?.kind === "pair" ? { ...open, awaitingLive: true } : open));
    await step(
      async () => {
        const checked = await refresh(stall);
        if (!checked.registry) throw new Error("This stall is not ready for a terminal yet.");
        if (!checked.registry.configOpen) throw new Error("The event is closed for new terminals.");
        if (!checked.registry.terminalRegistered) {
          setProgressNote("Registering the terminal…");
          await runRegistryOperation({
            api,
            token,
            eventId,
            chainId,
            onProgress: setProgressNote,
            body: {
              kind: "TERMINAL",
              terminalId: stall.terminal.instanceId,
              version: stall.terminal.keyVersion,
              vendorId: stall.vendorId,
              signer: stall.terminal.pendingSigner,
              validAfter: String(checked.registry.terminalWindow.validAfter),
              validUntil: String(checked.registry.terminalWindow.validUntil),
            },
          });
        }
        const done = await refresh(stall);
        await load();
        if (done.stall.state !== "LIVE")
          throw new Error("The network has not confirmed it yet. Try again in a minute.");
        setDialog(undefined);
      },
      `${stall.stallName ?? stall.label} is live. Customers can now choose it.`,
    );
  }

  const current =
    dialog && "stallId" in dialog
      ? stalls.find((stall) => stall.stallId === dialog.stallId)
      : undefined;
  const active = stalls.filter((stall) => stall.state !== "DECLINED");
  const declined = stalls.filter((stall) => stall.state === "DECLINED");
  const listed = showDeclined ? declined : active;
  const onboardedNames = new Set(stalls.map((stall) => stall.stallName));
  const fixed = existing.filter((name) => !onboardedNames.has(name));

  return (
    <section className="shell operations-panel stalls-panel" aria-labelledby="stalls-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Event setup</p>
          <h2 id="stalls-heading">Stalls</h2>
        </div>
        <div className="section-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={refreshing}
            onClick={refreshList}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" disabled={busy} onClick={() => setDialog({ kind: "invite" })}>
            Invite a stall
          </button>
        </div>
      </div>
      <p className="muted">
        Send each stall an invite. They add their details, you approve, and they pair their phone.
      </p>

      {message && !dialog && (
        <div
          role="status"
          aria-live="polite"
          className={`notice dismissible ${message.tone === "info" ? "" : message.tone}`}
        >
          <span>{message.text}</span>
          <button
            type="button"
            className="text-button"
            aria-label="Dismiss"
            onClick={() => setMessage(undefined)}
          >
            ✕
          </button>
        </div>
      )}

      {declined.length === 0 ? (
        <p className="stall-count">
          {active.length + fixed.length} stall{active.length + fixed.length === 1 ? "" : "s"}
        </p>
      ) : (
        <div className="segmented" role="tablist" aria-label="Stall list">
          <button
            type="button"
            role="tab"
            aria-selected={!showDeclined}
            onClick={() => {
              setShowDeclined(false);
              setShown(PAGE);
            }}
          >
            Active {active.length + fixed.length}
          </button>
          {declined.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={showDeclined}
              onClick={() => {
                setShowDeclined(true);
                setShown(PAGE);
              }}
            >
              Declined {declined.length}
            </button>
          )}
        </div>
      )}

      <ul className="stall-list">
        {!showDeclined &&
          fixed.map((name) => (
            <li key={`fixed:${name}`}>
              <div>
                <strong>{name}</strong>
              </div>
              <span className="chip" data-tone="ok">
                Live
              </span>
            </li>
          ))}
        {listed.slice(0, shown).map((stall) => {
          const control = controlOf(stall);
          const detail = detailOf(stall);
          const name = stall.stallName ?? stall.label;
          const menu =
            stall.state === "INVITED"
              ? [{ label: "Cancel invite", onSelect: () => decline(stall) }]
              : stall.state === "LIVE" && !stall.terminal.moved
                ? [
                    {
                      label: "Show setup code again",
                      onSelect: () => setDialog({ kind: "pair", stallId: stall.stallId }),
                    },
                  ]
                : [];
          return (
            <li key={stall.stallId}>
              <div>
                <strong>{name}</strong>
                {detail && <small>{detail}</small>}
              </div>
              <div className="stall-actions">
                {control.kind === "chip" ? (
                  <span className="chip" data-tone={control.tone}>
                    {control.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setDialog(
                        control.open === "review"
                          ? { kind: "review", stallId: stall.stallId }
                          : { kind: "pair", stallId: stall.stallId, moved: stall.terminal.moved },
                      )
                    }
                  >
                    {control.label}
                  </button>
                )}
                {menu.length > 0 && (
                  <RowMenu label={`More actions for ${name}`} disabled={busy} items={menu} />
                )}
              </div>
            </li>
          );
        })}
        {loaded && listed.length === 0 && (showDeclined || fixed.length === 0) && (
          <li className="empty-state">
            {showDeclined ? "No declined stalls." : "No stalls yet. Invite your first stall."}
          </li>
        )}
      </ul>
      {listed.length > shown && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => setShown((count) => count + PAGE)}
        >
          Show more
        </button>
      )}

      {dialog?.kind === "invite" && (
        <Modal title="Invite a stall" onClose={() => setDialog(undefined)}>
          <p className="muted">
            Name the invite so you recognise it. The owner chooses the stall name customers see.
          </p>
          <label>
            Invite name
            <input
              value={label}
              maxLength={80}
              placeholder="For example: Taco truck, gate B"
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") createInvite();
              }}
            />
          </label>
          {message?.tone === "error" && (
            <p role="alert" className="notice error">
              {message.text}
            </p>
          )}
          <button type="button" className="block-button" disabled={busy} onClick={createInvite}>
            {busy ? "Creating…" : "Create invite link"}
          </button>
        </Modal>
      )}

      {dialog?.kind === "invite-link" && (
        <Modal title="Send this link to the stall owner" onClose={() => setDialog(undefined)}>
          <p className="muted">
            Invite for <strong>{dialog.label}</strong>. It works once and expires in 7 days. Anyone
            with the link can fill it in, so send it privately.
          </p>
          <div className="qr-frame">
            {/* biome-ignore lint/performance/noImgElement: a generated data URL needs no optimization */}
            <img
              src={dialog.image}
              alt="QR code of the stall invite link"
              width={240}
              height={240}
            />
          </div>
          <input
            readOnly
            value={dialog.link}
            aria-label="Invite link"
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="block-button"
            onClick={() =>
              navigator.clipboard
                .writeText(dialog.link)
                .then(() => setMessage({ text: "Invite link copied.", tone: "success" }))
                .catch(() => undefined)
            }
          >
            Copy link
          </button>
        </Modal>
      )}

      {dialog?.kind === "review" && current && (
        <Modal title="Review stall" onClose={() => setDialog(undefined)}>
          <dl className="review-list">
            <div>
              <dt>Stall name</dt>
              <dd>{current.stallName}</dd>
            </div>
            <div>
              <dt>Sells</dt>
              <dd>{current.category}</dd>
            </div>
            {current.authority === current.payoutAddress ? (
              <div>
                <dt>Owner and earnings wallet</dt>
                <dd>{current.authority ? shortAddress(current.authority) : "—"}</dd>
              </div>
            ) : (
              <>
                <div>
                  <dt>Owner wallet</dt>
                  <dd>{current.authority ? shortAddress(current.authority) : "—"}</dd>
                </div>
                <div>
                  <dt>Earnings go to</dt>
                  <dd>{current.payoutAddress ? shortAddress(current.payoutAddress) : "—"}</dd>
                </div>
              </>
            )}
          </dl>
          {message?.tone === "error" && (
            <p role="alert" className="notice error">
              {message.text}
            </p>
          )}
          <p className="fine-print">
            The owner signed this payout address. You'll confirm <strong>2 times</strong> in your
            organizer wallet. You cannot change where the stall is paid later.
          </p>
          <button
            type="button"
            className="block-button"
            disabled={busy}
            onClick={() => approve(current)}
          >
            {busy ? progressNote || "Working…" : "Approve and register"}
          </button>
          <button
            type="button"
            className="secondary-button block-button"
            disabled={busy}
            onClick={() => decline(current)}
          >
            Decline
          </button>
        </Modal>
      )}

      {dialog?.kind === "pair" && current && (
        <Modal
          title={`Set up ${current.stallName ?? "the stall"}'s phone`}
          onClose={() => setDialog(undefined)}
        >
          {current.state === "APPROVED" && current.terminal.pendingSigner ? (
            // The phone checked in: one main action, the setup code only as a quiet fallback.
            <>
              <p role="status" className="notice success">
                <strong>Phone checked in.</strong> Approve it to put the stall live. You'll confirm
                once in your wallet.
              </p>
              <button
                type="button"
                className="block-button"
                disabled={busy}
                aria-busy={busy}
                onClick={() => approveTerminal(current)}
              >
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden="true" />{" "}
                    {progressNote || "Confirm in your wallet…"}
                  </>
                ) : (
                  "Approve terminal"
                )}
              </button>
              {message?.tone === "error" && (
                <p role="alert" className="notice error">
                  {message.text}
                </p>
              )}
              {!busy && (
                <button type="button" className="text-button" onClick={() => setupCode(current)}>
                  Wrong phone? Show a new setup code
                </button>
              )}
            </>
          ) : (
            <>
              {current.state === "LIVE" && !current.terminal.moved && dialog.moved && (
                <p role="status" className="notice success">
                  Done. The phone sells for {current.stallName} again.
                </p>
              )}
              {current.state === "LIVE" && !current.terminal.moved && !dialog.moved && (
                <p className="muted">
                  Only needed if the stall's phone was reset or set up for another stall. The same
                  phone goes straight back to selling; a different phone is not supported yet.
                </p>
              )}
              {current.state === "LIVE" && current.terminal.moved && (
                <p className="muted">
                  This stall's phone now sells for another stall. Scan this stall's code on it again
                  to switch it back. No approval is needed.
                </p>
              )}
              <PhoneSetupSteps />
              {current.state === "APPROVED" && (
                <p className="fine-print">
                  The owner can also do this from their own invite link, without you.
                </p>
              )}
              {dialog.image ? (
                <>
                  <div className="qr-frame">
                    {/* biome-ignore lint/performance/noImgElement: a generated data URL needs no optimization */}
                    <img src={dialog.image} alt="Terminal setup code" width={260} height={260} />
                  </div>
                  <p className="fine-print">
                    This code signs the terminal in as this stall. Show it only to the stall owner.
                    A new code replaces this one.
                  </p>
                  {current.state === "APPROVED" && (
                    <p className="muted waiting" aria-live="polite">
                      <span className="spinner" aria-hidden="true" /> Waiting for the phone to check
                      in…
                    </p>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className={
                    current.state === "LIVE" ? "secondary-button block-button" : "block-button"
                  }
                  disabled={busy}
                  onClick={() => setupCode(current)}
                >
                  {busy
                    ? "Getting the code…"
                    : current.setupCodeIssued
                      ? "Show a new setup code"
                      : "Show setup code"}
                </button>
              )}
              {message?.tone === "error" && (
                <p role="alert" className="notice error">
                  {message.text}
                </p>
              )}
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
