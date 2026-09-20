import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { getAddress, type Hex } from "viem";
import { z } from "zod";

const environment = z
  .object({
    DATABASE_URL: z.string().min(1),
    VENDOR_TREASURY_EVENT_ID: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    VENDOR_TREASURY_VENDOR_ID: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    VENDOR_TREASURY_AUTHORITY: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    VENDOR_TREASURY_VALID_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(720),
  })
  .parse(process.env);

const token = randomBytes(32).toString("base64url");
const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 });
try {
  const result = await pool.query(
    `INSERT INTO vendor_treasury_credentials
       (credential_id, token_hash, event_id, vendor_id, authority_address, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))
     RETURNING credential_id`,
    [
      randomUUID(),
      createHash("sha256").update(token).digest("hex"),
      environment.VENDOR_TREASURY_EVENT_ID.toLowerCase(),
      environment.VENDOR_TREASURY_VENDOR_ID.toLowerCase(),
      getAddress(environment.VENDOR_TREASURY_AUTHORITY).toLowerCase(),
      environment.VENDOR_TREASURY_VALID_HOURS,
    ],
  );
  process.stdout.write(
    `${JSON.stringify({
      credentialId: result.rows[0]?.credential_id,
      eventId: environment.VENDOR_TREASURY_EVENT_ID as Hex,
      vendorId: environment.VENDOR_TREASURY_VENDOR_ID as Hex,
      token,
      note: "The token is shown once; store it in the operator secret store.",
    })}\n`,
  );
} finally {
  await pool.end();
}
