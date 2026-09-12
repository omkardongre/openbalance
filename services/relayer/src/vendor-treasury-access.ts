import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getAddress, type Hex } from "viem";

export type VendorTreasuryIdentity = {
  credentialId: string;
  eventId: Hex;
  vendorId: Hex;
  authorityAddress: `0x${string}`;
};

export class VendorTreasuryAccessRejected extends Error {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class VendorTreasuryAccessService {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      "SELECT to_regclass('public.vendor_treasury_credentials') AS credentials",
    );
    if (!result.rows[0]?.credentials)
      throw new Error("Vendor treasury credential migration is not installed");
  }

  async authenticate(authorization: string | undefined): Promise<VendorTreasuryIdentity> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match?.[1]) throw new VendorTreasuryAccessRejected();
    const result = await this.pool.query(
      `UPDATE vendor_treasury_credentials SET last_used_at=clock_timestamp()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
       RETURNING credential_id,event_id,vendor_id,authority_address`,
      [digest(match[1])],
    );
    const row = result.rows[0];
    if (!row) throw new VendorTreasuryAccessRejected();
    return {
      credentialId: row.credential_id,
      eventId: row.event_id as Hex,
      vendorId: row.vendor_id as Hex,
      authorityAddress: getAddress(row.authority_address),
    };
  }
}
