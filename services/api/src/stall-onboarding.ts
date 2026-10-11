import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { type Address, getAddress, type Hex, recoverTypedDataAddress, toHex } from "viem";
import type {
  CheckoutEventPolicy,
  CheckoutManifest,
  CheckoutVendorPolicy,
} from "./checkout-manifest.js";
import type { OperationsIdentity } from "./operations-access.js";

export class StallRejected extends Error {}
export class StallNotFound extends Error {}
export class StallConflict extends Error {}

/** Registry state for one stall at the latest finalized block. */
export type StallRegistryView = {
  vendor: { authority: Address; enabled: boolean };
  destination: { account: Address; enabled: boolean };
  terminal: {
    vendorId: Hex;
    signer: Address;
    validAfter: number;
    validUntil: number;
    enabled: boolean;
  };
  config: { validAfter: number; validUntil: number; enabled: boolean };
};

export type StallChain = {
  read(
    event: CheckoutEventPolicy & { chainId: number },
    query: { vendorId: Hex; destinationVersion: bigint; terminalId: Hex; terminalVersion: bigint },
  ): Promise<StallRegistryView>;
};

/** A stall the checkout service can serve: pairing (no terminal yet) or live (verified on chain). */
export type DynamicStall = {
  streamId: string;
  eventId: Hex;
  vendor: CheckoutVendorPolicy;
  live: boolean;
  /** Live, but its phone has since been set up for another stall, so nobody can take payments. */
  moved: boolean;
};

export type StallDirectory = {
  vendors(streamId: string, eventId: Hex): Promise<DynamicStall[]>;
  recordTerminalSigner(
    streamId: string,
    eventId: Hex,
    vendorId: Hex,
    signer: Address,
  ): Promise<void>;
  /** A live terminal for this stall checked in; it is the stall's phone again. */
  recordTerminalSeen(streamId: string, eventId: Hex, vendorId: Hex): Promise<void>;
};

type StallState = "INVITED" | "SUBMITTED" | "DECLINED" | "APPROVED" | "LIVE";

type StallRow = {
  stall_id: string;
  stream_id: string;
  event_id: Hex;
  vendor_id: Hex;
  terminal_instance_id: Hex;
  terminal_key_version: string;
  destination_version: string;
  invite_label: string;
  invite_expires_at: Date;
  state: StallState;
  stall_name: string | null;
  category: string | null;
  authority: Address | null;
  payout_address: Address | null;
  destination_deadline: string | null;
  vendor_signature: Hex | null;
  submitted_at: Date | null;
  pending_terminal_signer: Address | null;
  pending_terminal_seen_at: Date | null;
  terminal_signer: Address | null;
  setup_credential_id: string | null;
  owner_token_hash: string | null;
  terminal_seen_at: Date | null;
  created_at: Date;
  approved_at: Date | null;
  live_at: Date | null;
};

const INVITE_TTL_DAYS = 7;
const SETUP_CODE_TTL_HOURS = 24 * 30;
const MIN_APPROVAL_SECONDS = 60 * 60;
const MAX_APPROVAL_SECONDS = 30 * 24 * 60 * 60;
const CACHE_MILLISECONDS = 5_000;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/;
export const STALL_CATEGORIES = [
  "Food",
  "Drinks",
  "Coffee",
  "Merchandise",
  "Services",
  "Other",
] as const;

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Printable single-line text only: a stall name is shown on receipts and signed into vouchers. */
function cleanText(value: string, min: number, max: number): string {
  const text = value.normalize("NFC").trim().replace(/\s+/g, " ");
  const hasControl = Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || (code >= 127 && code < 160);
  });
  if (text.length < min || text.length > max || hasControl) throw new StallRejected();
  return text;
}

function checksummed(value: string): Address {
  if (!addressPattern.test(value)) throw new StallRejected();
  const address = getAddress(value);
  if (address.toLowerCase() === zeroAddress) throw new StallRejected();
  return address;
}

export function destinationApprovalTypedData(input: {
  chainId: number;
  registry: Address;
  vendorId: Hex;
  version: bigint;
  destination: Address;
  deadline: bigint;
}) {
  return {
    domain: {
      name: "OpenBalanceEventRegistry",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.registry,
    },
    types: {
      DestinationApproval: [
        { name: "vendorId", type: "bytes32" },
        { name: "version", type: "uint256" },
        { name: "destination", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "DestinationApproval" as const,
    message: {
      vendorId: input.vendorId,
      version: input.version,
      destination: input.destination,
      deadline: input.deadline,
    },
  };
}

/**
 * Organizer-led stall onboarding: invite, owner submission with a signed payout approval, organizer
 * registration on chain, then terminal pairing. Approval and go-live are decided only by reading the
 * registry at a finalized block, so this table can never make a stall look live that is not.
 */
export class StallOnboardingService implements StallDirectory {
  readonly #events: (CheckoutEventPolicy & { chainId: number })[];
  #cache: { at: number; rows: StallRow[] } | undefined;

  constructor(
    private readonly pool: Pool,
    manifest: CheckoutManifest,
    private readonly chain: StallChain,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#events = manifest.events.map((event) => ({ ...event, chainId: manifest.chainId }));
  }

  async assertReady(): Promise<void> {
    const result = await this.pool.query("SELECT to_regclass('public.stall_onboarding') AS stalls");
    if (!result.rows[0]?.stalls) throw new Error("Stall onboarding migration is not installed");
  }

  async createInvite(identity: OperationsIdentity, label: string) {
    const event = this.organizerEvent(identity);
    const name = cleanText(label, 1, 80);
    const token = randomBytes(32).toString("base64url");
    const inserted = await this.pool.query<StallRow>(
      `INSERT INTO stall_onboarding
         (stall_id,stream_id,event_id,vendor_id,terminal_instance_id,invite_label,
          invite_token_hash,invite_expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz+make_interval(days => $9),$10)
       RETURNING *`,
      [
        randomUUID(),
        event.streamId,
        event.eventId,
        toHex(randomBytes(32)),
        toHex(randomBytes(32)),
        name,
        tokenHash(token),
        this.now(),
        INVITE_TTL_DAYS,
        identity.principalId,
      ],
    );
    this.#cache = undefined;
    const row = inserted.rows[0];
    if (!row) throw new StallConflict();
    return { stall: this.publicStall(row), inviteToken: token };
  }

  async list(identity: OperationsIdentity) {
    const event = this.organizerEvent(identity);
    const result = await this.pool.query<StallRow>(
      `SELECT * FROM stall_onboarding WHERE stream_id=$1 AND event_id=$2
       ORDER BY created_at DESC LIMIT 200`,
      [event.streamId, event.eventId],
    );
    return {
      schemaVersion: 1 as const,
      chainId: event.chainId,
      registry: event.registry,
      items: result.rows.map((row) => this.publicStall(row, movedStalls(result.rows))),
    };
  }

  /**
   * Public: what the owner needs to fill in and sign, or, once submitted, where their stall stands.
   * Reveals nothing for an unknown or expired link.
   */
  async lookupInvite(token: string) {
    const row = await this.inviteRow(token);
    const event = this.eventFor(row.stream_id, row.event_id);
    if (row.state !== "INVITED") {
      const siblings = await this.eventRows(row.stream_id, row.event_id);
      const moved = movedStalls(siblings).has(row.stall_id);
      return {
        schemaVersion: 1 as const,
        state: row.state,
        stallName: row.stall_name,
        // What the owner should do next, in one word the page maps to plain steps.
        pairing:
          row.state === "APPROVED"
            ? row.pending_terminal_signer
              ? ("CHECKED_IN" as const)
              : ("NEEDS_PHONE" as const)
            : row.state === "LIVE" && moved
              ? ("NEEDS_PHONE" as const)
              : null,
      };
    }
    return {
      schemaVersion: 1 as const,
      state: row.state,
      label: row.invite_label,
      expiresAt: row.invite_expires_at.toISOString(),
      chainId: event.chainId,
      registry: event.registry,
      vendorId: row.vendor_id,
      destinationVersion: row.destination_version,
      assetSymbol: event.assetSymbol,
      categories: STALL_CATEGORIES,
    };
  }

  async submitInvite(
    token: string,
    input: {
      stallName: string;
      category: string;
      authority: string;
      payoutAddress: string;
      deadline: bigint;
      signature: string;
    },
  ) {
    const row = await this.inviteRow(token);
    const event = this.eventFor(row.stream_id, row.event_id);
    const stallName = cleanText(input.stallName, 2, 60);
    const category = cleanText(input.category, 2, 40);
    if (!STALL_CATEGORIES.includes(category as (typeof STALL_CATEGORIES)[number]))
      throw new StallRejected();
    const authority = checksummed(input.authority);
    const destination = checksummed(input.payoutAddress);
    if (!signaturePattern.test(input.signature)) throw new StallRejected();
    const nowSeconds = BigInt(Math.floor(this.now().getTime() / 1_000));
    // Long enough for the organizer to review, short enough that a stale approval cannot linger.
    if (
      input.deadline < nowSeconds + BigInt(MIN_APPROVAL_SECONDS) ||
      input.deadline > nowSeconds + BigInt(MAX_APPROVAL_SECONDS)
    )
      throw new StallRejected();
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        ...destinationApprovalTypedData({
          chainId: event.chainId,
          registry: event.registry,
          vendorId: row.vendor_id,
          version: BigInt(row.destination_version),
          destination,
          deadline: input.deadline,
        }),
        signature: input.signature as Hex,
      });
    } catch {
      throw new StallRejected();
    }
    if (signer !== authority) throw new StallRejected();
    const updated = await this.pool.query<StallRow>(
      `UPDATE stall_onboarding SET state='SUBMITTED',invite_token_hash=NULL,owner_token_hash=$1,stall_name=$2,
         category=$3,authority=$4,payout_address=$5,destination_deadline=$6,vendor_signature=$7,
         submitted_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE invite_token_hash=$1 AND state='INVITED' AND invite_expires_at>$8
       RETURNING *`,
      [
        tokenHash(token),
        stallName,
        category,
        authority.toLowerCase(),
        destination.toLowerCase(),
        input.deadline.toString(),
        input.signature.toLowerCase(),
        this.now(),
      ],
    );
    if (!updated.rows[0]) throw new StallNotFound();
    this.#cache = undefined;
    return { schemaVersion: 1 as const, state: "SUBMITTED" as const, stallName };
  }

  async decline(identity: OperationsIdentity, stallId: string) {
    const event = this.organizerEvent(identity);
    const result = await this.pool.query<StallRow>(
      `UPDATE stall_onboarding SET state='DECLINED',invite_token_hash=NULL,
         updated_at=clock_timestamp()
       WHERE stall_id=$1 AND stream_id=$2 AND event_id=$3 AND state IN ('INVITED','SUBMITTED')
       RETURNING *`,
      [stallId, event.streamId, event.eventId],
    );
    const row = result.rows[0];
    if (!row) throw new StallConflict();
    this.#cache = undefined;
    return this.publicStall(row);
  }

  /**
   * Reads the registry at the finalized block and moves the stall forward only as far as the chain
   * shows: SUBMITTED → APPROVED once vendor and payout are registered as submitted, APPROVED → LIVE
   * once the paired terminal key is registered for this vendor.
   */
  async refresh(identity: OperationsIdentity, stallId: string) {
    const event = this.organizerEvent(identity);
    const row = await this.organizerRow(event, stallId);
    if (row.state === "INVITED" || row.state === "DECLINED")
      return { stall: this.publicStall(row), registry: null };
    const view = await this.chain.read(event, {
      vendorId: row.vendor_id,
      destinationVersion: BigInt(row.destination_version),
      terminalId: row.terminal_instance_id,
      terminalVersion: BigInt(row.terminal_key_version),
    });
    const vendorRegistered =
      view.vendor.enabled && view.vendor.authority.toLowerCase() === row.authority;
    const destinationRegistered =
      view.destination.enabled && view.destination.account.toLowerCase() === row.payout_address;
    const terminalRegistered =
      view.terminal.enabled &&
      view.terminal.signer.toLowerCase() !== zeroAddress &&
      view.terminal.vendorId.toLowerCase() === row.vendor_id;
    let current = row;
    if (current.state === "SUBMITTED" && vendorRegistered && destinationRegistered) {
      current = await this.transition(current, "APPROVED", "approved_at=clock_timestamp()");
    }
    if (current.state === "APPROVED" && terminalRegistered) {
      current = await this.transition(
        current,
        "LIVE",
        "live_at=clock_timestamp(),terminal_signer=$4",
        [view.terminal.signer.toLowerCase()],
      );
    }
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    return {
      stall: this.publicStall(current),
      registry: {
        vendorRegistered,
        destinationRegistered,
        terminalRegistered,
        terminalSigner: terminalRegistered ? getAddress(view.terminal.signer) : null,
        // The registration window the organizer wallet should submit for this terminal: from now
        // until the event configuration ends, which is the longest a reserve can accept sales.
        terminalWindow: {
          validAfter: Math.max(nowSeconds - 60, view.config.validAfter),
          validUntil: view.config.validUntil,
        },
        configOpen: view.config.enabled && view.config.validUntil > nowSeconds,
      },
    };
  }

  /**
   * The owner shows the setup code from their own invite link, so pairing needs no meeting. Only
   * while a phone is needed; the organizer still approves the exact key that checks in.
   */
  async issueOwnerSetupCode(ownerToken: string) {
    const row = await this.inviteRow(ownerToken);
    if (row.state !== "APPROVED" && row.state !== "LIVE") throw new StallConflict();
    if (row.state === "LIVE") {
      const siblings = await this.eventRows(row.stream_id, row.event_id);
      if (!movedStalls(siblings).has(row.stall_id)) throw new StallConflict();
    }
    return this.issueSetupCodeFor(row.stall_id, row.stream_id, row.event_id);
  }

  /**
   * Issues the terminal's setup credential (a vendor-scoped operations token) for a stall whose
   * vendor and payout are on chain. Re-issuing revokes the previous one, so a leaked code dies with it.
   */
  async issueSetupCode(identity: OperationsIdentity, stallId: string) {
    const event = this.organizerEvent(identity);
    return this.issueSetupCodeFor(stallId, event.streamId, event.eventId);
  }

  private async issueSetupCodeFor(stallId: string, streamId: string, eventId: Hex) {
    const token = randomBytes(32).toString("base64url");
    const credentialId = randomUUID();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const found = await db.query<StallRow>(
        `SELECT * FROM stall_onboarding WHERE stall_id=$1 AND stream_id=$2 AND event_id=$3
         FOR UPDATE`,
        [stallId, streamId, eventId],
      );
      const row = found.rows[0];
      if (!row) throw new StallNotFound();
      if (row.state !== "APPROVED" && row.state !== "LIVE") throw new StallConflict();
      if (row.setup_credential_id)
        await db.query(
          `UPDATE operations_access_credentials SET revoked_at=clock_timestamp()
           WHERE credential_id=$1 AND revoked_at IS NULL`,
          [row.setup_credential_id],
        );
      const inserted = await db.query<{ expires_at: Date }>(
        `INSERT INTO operations_access_credentials
           (credential_id,token_hash,principal_id,role,stream_id,event_id,vendor_id,expires_at)
         VALUES ($1,$2,$3,'VENDOR',$4,$5,$6,clock_timestamp()+make_interval(hours => $7))
         RETURNING expires_at`,
        [
          credentialId,
          tokenHash(token),
          `stall:${row.stall_id}`,
          row.stream_id,
          row.event_id,
          row.vendor_id,
          SETUP_CODE_TTL_HOURS,
        ],
      );
      await db.query(
        `UPDATE stall_onboarding SET setup_credential_id=$2,updated_at=clock_timestamp()
         WHERE stall_id=$1`,
        [row.stall_id, credentialId],
      );
      await db.query("COMMIT");
      return {
        schemaVersion: 1 as const,
        accessToken: token,
        expiresAt: inserted.rows[0]?.expires_at.toISOString() ?? null,
      };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async vendors(streamId: string, eventId: Hex): Promise<DynamicStall[]> {
    const nowMs = this.now().getTime();
    if (!this.#cache || nowMs - this.#cache.at > CACHE_MILLISECONDS) {
      const result = await this.pool.query<StallRow>(
        "SELECT * FROM stall_onboarding WHERE state IN ('APPROVED','LIVE') LIMIT 1000",
      );
      this.#cache = { at: nowMs, rows: result.rows };
    }
    const event = this.#events.find(
      (candidate) => candidate.streamId === streamId && candidate.eventId === eventId.toLowerCase(),
    );
    if (!event) return [];
    const policy = defaultReservePolicy(event);
    const rows = this.#cache.rows.filter(
      (row) => row.stream_id === streamId && row.event_id === event.eventId,
    );
    const moved = movedStalls(rows);
    return rows.flatMap((row) =>
      row.stall_name
        ? [
            {
              streamId,
              eventId: event.eventId,
              live: row.state === "LIVE" && Boolean(row.terminal_signer),
              moved: moved.has(row.stall_id),
              vendor: {
                vendorId: row.vendor_id,
                vendorName: row.stall_name,
                destinationVersion: BigInt(row.destination_version),
                terminal: {
                  instanceId: row.terminal_instance_id,
                  keyVersion: BigInt(row.terminal_key_version),
                  signer: getAddress(row.terminal_signer ?? zeroAddress),
                },
                reservePolicy: policy,
              },
            },
          ]
        : [],
    );
  }

  async recordTerminalSigner(streamId: string, eventId: Hex, vendorId: Hex, signer: Address) {
    await this.pool.query(
      `UPDATE stall_onboarding SET pending_terminal_signer=$4,
         pending_terminal_seen_at=clock_timestamp(),terminal_seen_at=clock_timestamp(),
         updated_at=clock_timestamp()
       WHERE stream_id=$1 AND event_id=$2 AND vendor_id=$3 AND state='APPROVED'`,
      [streamId, eventId.toLowerCase(), vendorId.toLowerCase(), signer.toLowerCase()],
    );
    this.#cache = undefined;
  }

  async recordTerminalSeen(streamId: string, eventId: Hex, vendorId: Hex) {
    const result = await this.pool.query(
      `UPDATE stall_onboarding SET terminal_seen_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE stream_id=$1 AND event_id=$2 AND vendor_id=$3 AND state='LIVE'`,
      [streamId, eventId.toLowerCase(), vendorId.toLowerCase()],
    );
    if (result.rowCount) this.#cache = undefined;
  }

  private async eventRows(streamId: string, eventId: Hex) {
    const result = await this.pool.query<StallRow>(
      `SELECT * FROM stall_onboarding WHERE stream_id=$1 AND event_id=$2
         AND state IN ('APPROVED','LIVE') LIMIT 1000`,
      [streamId, eventId],
    );
    return result.rows;
  }

  private async transition(
    row: StallRow,
    next: StallState,
    assignments: string,
    extra: unknown[] = [],
  ): Promise<StallRow> {
    // `assignments` is a fixed fragment from this class; values travel as parameters ($4 onwards).
    const result = await this.pool.query<StallRow>(
      `UPDATE stall_onboarding SET state=$3,${assignments},updated_at=clock_timestamp()
       WHERE stall_id=$1 AND state=$2 RETURNING *`,
      [row.stall_id, row.state, next, ...extra],
    );
    this.#cache = undefined;
    return result.rows[0] ?? row;
  }

  private async inviteRow(token: string): Promise<StallRow> {
    if (!tokenPattern.test(token)) throw new StallNotFound();
    // An unused invite until it expires; after submission the same link is the owner's status link.
    const result = await this.pool.query<StallRow>(
      `SELECT * FROM stall_onboarding
       WHERE (invite_token_hash=$1 AND state='INVITED' AND invite_expires_at>$2)
          OR owner_token_hash=$1`,
      [tokenHash(token), this.now()],
    );
    const row = result.rows[0];
    if (!row) throw new StallNotFound();
    return row;
  }

  private async organizerRow(
    event: CheckoutEventPolicy,
    stallId: string,
    db: Pool | PoolClient = this.pool,
  ): Promise<StallRow> {
    const result = await db.query<StallRow>(
      "SELECT * FROM stall_onboarding WHERE stall_id=$1 AND stream_id=$2 AND event_id=$3",
      [stallId, event.streamId, event.eventId],
    );
    const row = result.rows[0];
    if (!row) throw new StallNotFound();
    return row;
  }

  private organizerEvent(identity: OperationsIdentity) {
    if (identity.role !== "ORGANIZER") throw new StallRejected();
    return this.eventFor(identity.streamId, identity.eventId);
  }

  private eventFor(streamId: string, eventId: Hex) {
    const event = this.#events.find(
      (candidate) => candidate.streamId === streamId && candidate.eventId === eventId.toLowerCase(),
    );
    if (!event) throw new StallNotFound();
    return event;
  }

  private publicStall(row: StallRow, moved: Set<string> = new Set()) {
    return {
      stallId: row.stall_id,
      label: row.invite_label,
      state: row.state,
      stallName: row.stall_name,
      category: row.category,
      vendorId: row.vendor_id,
      authority: row.authority ? getAddress(row.authority) : null,
      payoutAddress: row.payout_address ? getAddress(row.payout_address) : null,
      destinationVersion: row.destination_version,
      // Public once registered; the organizer wallet submits it with the payout registration.
      destinationDeadline: row.destination_deadline,
      vendorSignature: row.vendor_signature,
      terminal: {
        instanceId: row.terminal_instance_id,
        keyVersion: row.terminal_key_version,
        pendingSigner: row.pending_terminal_signer ? getAddress(row.pending_terminal_signer) : null,
        pendingSeenAt: row.pending_terminal_seen_at?.toISOString() ?? null,
        signer: row.terminal_signer ? getAddress(row.terminal_signer) : null,
        // Live on chain, but its phone was set up for another stall since: needs a phone again.
        moved: moved.has(row.stall_id),
      },
      setupCodeIssued: Boolean(row.setup_credential_id),
      inviteExpiresAt: row.invite_expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      approvedAt: row.approved_at?.toISOString() ?? null,
      liveAt: row.live_at?.toISOString() ?? null,
    };
  }
}

/**
 * Stalls whose phone moved: a terminal key holds one setup at a time, so of the stalls sharing a
 * key, only the one it checked in for last still has that phone.
 */
export type MovedStallRow = Pick<
  StallRow,
  "stall_id" | "state" | "terminal_signer" | "pending_terminal_signer" | "terminal_seen_at"
>;

export function movedStalls(rows: readonly MovedStallRow[]): Set<string> {
  const latest = new Map<string, MovedStallRow>();
  for (const row of rows) {
    const key = row.terminal_signer ?? row.pending_terminal_signer;
    if (!key || !row.terminal_seen_at || (row.state !== "LIVE" && row.state !== "APPROVED"))
      continue;
    const best = latest.get(key);
    if (!best?.terminal_seen_at || row.terminal_seen_at > best.terminal_seen_at)
      latest.set(key, row);
  }
  const moved = new Set<string>();
  for (const row of rows) {
    if (row.state !== "LIVE" || !row.terminal_signer) continue;
    const owner = latest.get(row.terminal_signer);
    if (owner && owner.stall_id !== row.stall_id) moved.add(row.stall_id);
  }
  return moved;
}

/** New stalls take the event's existing reserve limits, so every stall offers the same choices. */
function defaultReservePolicy(event: CheckoutEventPolicy): CheckoutVendorPolicy["reservePolicy"] {
  return (
    event.vendors[0]?.reservePolicy ?? {
      maximumReserveUnits: 50n * 10n ** BigInt(event.assetDecimals),
      maximumPerVoucherUnits: 15n * 10n ** BigInt(event.assetDecimals),
      maximumVoucherCount: 8,
      acceptanceDurationSeconds: 7_200,
      submissionDelaySeconds: 1_800,
    }
  );
}
