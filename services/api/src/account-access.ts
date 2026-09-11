import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Pool, PoolClient } from "pg";
import { getAddress } from "viem";
import type { EnrollmentPolicy } from "./enrollment.js";
import { PasskeyAssertionRejected, verifyStrictPasskeyAssertion } from "./webauthn.js";

export class AccountAccessRejected extends Error {}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type AccountIdentity = {
  enrollmentId: string;
  account: `0x${string}`;
};

export class AccountAccessService {
  constructor(
    private readonly pool: Pool,
    private readonly policy: EnrollmentPolicy,
    private readonly sessionTtlMinutes = 15,
  ) {}

  async begin(accountInput: string) {
    let account: string;
    try {
      account = getAddress(accountInput);
    } catch {
      throw new AccountAccessRejected();
    }
    const result = await this.pool.query(
      `SELECT e.id, e.credential
       FROM account_deployments d JOIN account_enrollments e ON e.id=d.enrollment_id
       WHERE d.account_address=$1 AND d.verified_block IS NOT NULL
         AND e.status='verified' AND e.rp_id=$2 AND e.origin=$3`,
      [account, this.policy.rpId, this.policy.origin],
    );
    const row = result.rows[0];
    if (!row?.credential?.id) throw new AccountAccessRejected();
    const challenge = randomBytes(32).toString("base64url");
    const challengeToken = randomBytes(32).toString("base64url");
    await this.pool.query(
      `INSERT INTO account_authentication_challenges
       (id,enrollment_id,challenge_hash,challenge,expires_at)
       VALUES ($1,$2,$3,$4,now()+interval '5 minutes')`,
      [randomUUID(), row.id, digest(challengeToken), challenge],
    );
    return {
      challengeToken,
      options: {
        challenge,
        rpId: this.policy.rpId,
        allowCredentials: [{ id: row.credential.id, type: "public-key" as const }],
        userVerification: "required" as const,
        timeout: 120_000,
      },
    };
  }

  async verify(challengeToken: string, response: AuthenticationResponseJSON) {
    if (!tokenPattern.test(challengeToken)) throw new AccountAccessRejected();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query(
        `SELECT c.id AS challenge_id,c.challenge,e.id AS enrollment_id,e.credential,e.rp_id,e.origin,
                d.account_address
         FROM account_authentication_challenges c
         JOIN account_enrollments e ON e.id=c.enrollment_id
         JOIN account_deployments d ON d.enrollment_id=e.id
         WHERE c.challenge_hash=$1 AND c.consumed_at IS NULL
           AND c.expires_at > clock_timestamp() AND d.verified_block IS NOT NULL
         FOR UPDATE OF c,e`,
        [digest(challengeToken)],
      );
      const row = result.rows[0];
      if (!row || row.rp_id !== this.policy.rpId || row.origin !== this.policy.origin)
        throw new AccountAccessRejected();
      let newCounter: number;
      try {
        newCounter = await verifyStrictPasskeyAssertion({
          response,
          credential: row.credential,
          challenge: row.challenge,
          rpId: row.rp_id,
          origin: row.origin,
        });
      } catch (error) {
        if (error instanceof PasskeyAssertionRejected) throw new AccountAccessRejected();
        throw error;
      }
      const sessionToken = randomBytes(32).toString("base64url");
      const sessionId = randomUUID();
      await db.query(
        "UPDATE account_authentication_challenges SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL",
        [row.challenge_id],
      );
      await db.query(
        "UPDATE account_enrollments SET credential=jsonb_set(credential,'{counter}',to_jsonb($2::integer)) WHERE id=$1",
        [row.enrollment_id, newCounter],
      );
      await db.query(
        `INSERT INTO account_sessions (id,enrollment_id,session_hash,expires_at)
         VALUES ($1,$2,$3,now()+make_interval(mins => $4))`,
        [sessionId, row.enrollment_id, digest(sessionToken), this.sessionTtlMinutes],
      );
      await db.query("COMMIT");
      return {
        sessionToken,
        expiresInSeconds: this.sessionTtlMinutes * 60,
        account: getAddress(row.account_address),
      };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async authenticate(authorization: string | undefined, db?: PoolClient): Promise<AccountIdentity> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match?.[1]) throw new AccountAccessRejected();
    const query = db ?? this.pool;
    const result = await query.query(
      `UPDATE account_sessions s SET last_seen_at=now()
       FROM account_deployments d
       WHERE s.session_hash=$1 AND s.enrollment_id=d.enrollment_id
         AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
         AND d.verified_block IS NOT NULL
       RETURNING s.enrollment_id,d.account_address`,
      [digest(match[1])],
    );
    const row = result.rows[0];
    if (!row) throw new AccountAccessRejected();
    return { enrollmentId: row.enrollment_id, account: getAddress(row.account_address) };
  }

  async me(authorization: string | undefined) {
    const identity = await this.authenticate(authorization);
    return { account: identity.account };
  }

  async revoke(authorization: string | undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match?.[1]) throw new AccountAccessRejected();
    const result = await this.pool.query(
      `UPDATE account_sessions SET revoked_at=now()
       WHERE session_hash=$1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
      [digest(match[1])],
    );
    if (result.rowCount !== 1) throw new AccountAccessRejected();
    return { status: "revoked" as const };
  }
}
