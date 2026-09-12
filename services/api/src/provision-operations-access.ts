import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
const environment = z
  .object({
    DATABASE_URL: z.string().min(1),
    OPERATIONS_PRINCIPAL_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/),
    OPERATIONS_ROLE: z.enum(["VENDOR", "ORGANIZER", "FINANCE", "SUPPORT"]),
    OPERATIONS_STREAM_ID: z.string().min(3).max(255),
    OPERATIONS_EVENT_ID: bytes32,
    OPERATIONS_VENDOR_ID: bytes32.optional(),
    OPERATIONS_CREDENTIAL_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24),
  })
  .passthrough()
  .superRefine((value, context) => {
    if ((value.OPERATIONS_ROLE === "VENDOR") !== Boolean(value.OPERATIONS_VENDOR_ID))
      context.addIssue({
        code: "custom",
        message: "Vendor credentials require exactly one vendor identifier",
      });
  })
  .parse(process.env);

async function provision() {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO operations_access_credentials
        (credential_id,token_hash,principal_id,role,stream_id,event_id,vendor_id,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+make_interval(hours => $8))`,
      [
        randomUUID(),
        tokenHash,
        environment.OPERATIONS_PRINCIPAL_ID,
        environment.OPERATIONS_ROLE,
        environment.OPERATIONS_STREAM_ID,
        environment.OPERATIONS_EVENT_ID,
        environment.OPERATIONS_VENDOR_ID ?? null,
        environment.OPERATIONS_CREDENTIAL_TTL_HOURS,
      ],
    );
    process.stdout.write(`${token}\n`);
  } finally {
    await pool.end();
  }
}

provision().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", service: "operations-access-provisioner", message: error instanceof Error ? error.message : "Provisioning failed" })}\n`,
  );
  process.exitCode = 1;
});
