import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Hex } from "viem";

export type OperationsRole = "VENDOR" | "ORGANIZER" | "FINANCE" | "SUPPORT";

export type OperationsIdentity = {
  credentialId: string;
  principalId: string;
  role: OperationsRole;
  streamId: string;
  eventId: Hex;
  vendorId: Hex | null;
};

export class OperationsAccessRejected extends Error {}
export class OperationsScopeRejected extends Error {}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export class OperationsAccessService {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      "SELECT to_regclass('public.operations_access_credentials') AS credentials",
    );
    if (!result.rows[0]?.credentials)
      throw new Error("Operations access migration is not installed");
  }

  async authenticate(authorization: string | undefined): Promise<OperationsIdentity> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match?.[1] || !tokenPattern.test(match[1])) throw new OperationsAccessRejected();
    const result = await this.pool.query(
      `UPDATE operations_access_credentials SET last_used_at=clock_timestamp()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
       RETURNING credential_id,principal_id,role,stream_id,event_id,vendor_id`,
      [tokenHash(match[1])],
    );
    const row = result.rows[0];
    if (!row) throw new OperationsAccessRejected();
    return {
      credentialId: row.credential_id,
      principalId: row.principal_id,
      role: row.role,
      streamId: row.stream_id,
      eventId: row.event_id as Hex,
      vendorId: (row.vendor_id as Hex | null) ?? null,
    };
  }

  assertEvent(identity: OperationsIdentity, eventId: Hex): void {
    if (identity.eventId.toLowerCase() !== eventId.toLowerCase())
      throw new OperationsScopeRejected();
  }

  assertVendor(identity: OperationsIdentity, vendorId: Hex): void {
    if (identity.role === "VENDOR" && identity.vendorId?.toLowerCase() !== vendorId.toLowerCase())
      throw new OperationsScopeRejected();
  }

  assertRole(identity: OperationsIdentity, allowed: readonly OperationsRole[]): void {
    if (!allowed.includes(identity.role)) throw new OperationsScopeRejected();
  }
}
