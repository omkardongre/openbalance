import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import type { Pool } from "pg";
import { PasskeyAssertionRejected, verifyStrictPasskeyAssertion } from "./webauthn.js";

export class EnrollmentRejected extends Error {}
async function verifyCeremony<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new EnrollmentRejected();
  }
}
export type EnrollmentPolicy = { rpId: string; origin: string };
export function validateEnrollmentPolicy(policy: EnrollmentPolicy): EnrollmentPolicy {
  const site = new URL(policy.origin);
  if (
    site.origin !== policy.origin ||
    (site.protocol !== "https:" && !(site.protocol === "http:" && site.hostname === "localhost")) ||
    !(site.hostname === policy.rpId || site.hostname.endsWith(`.${policy.rpId}`)) ||
    !policy.rpId ||
    policy.rpId.includes(":")
  )
    throw new Error("Invalid WebAuthn domain policy");
  return policy;
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export class EnrollmentService {
  constructor(
    private readonly pool: Pool,
    private readonly policy: EnrollmentPolicy,
  ) {
    validateEnrollmentPolicy(policy);
  }

  async begin() {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const options = await generateRegistrationOptions({
      rpName: "OpenBalance",
      rpID: this.policy.rpId,
      userName: id,
      userID: randomBytes(32),
      attestationType: "none",
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 120_000,
    });
    await this.pool.query(
      "INSERT INTO account_enrollments (id, token_hash, challenge, rp_id, origin, status, expires_at) VALUES ($1,$2,$3,$4,$5,'register',now() + interval '5 minutes')",
      [id, hash(token), options.challenge, this.policy.rpId, this.policy.origin],
    );
    return { token, options };
  }

  async verify(
    token: string,
    kind: "register" | "prove",
    response: RegistrationResponseJSON | AuthenticationResponseJSON,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new EnrollmentRejected();
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query(
        "SELECT * FROM account_enrollments WHERE token_hash=$1 AND status=$2 AND expires_at > clock_timestamp() FOR UPDATE",
        [hash(token), kind],
      );
      const row = result.rows[0];
      if (!row || row.rp_id !== this.policy.rpId || row.origin !== this.policy.origin)
        throw new EnrollmentRejected();
      // JSON client data is untrusted and cross-origin ceremonies are not accepted.
      const client = JSON.parse(
        Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"),
      );
      if (
        !client ||
        typeof client !== "object" ||
        (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
        client.topOrigin !== undefined
      )
        throw new EnrollmentRejected();
      if (kind === "register") {
        const verified = await verifyCeremony(() =>
          verifyRegistrationResponse({
            response: response as RegistrationResponseJSON,
            expectedChallenge: row.challenge,
            expectedOrigin: row.origin,
            expectedRPID: row.rp_id,
            requireUserPresence: true,
            requireUserVerification: true,
            supportedAlgorithmIDs: [-7],
          }),
        );
        if (!verified.verified) throw new EnrollmentRejected();
        const credential = verified.registrationInfo.credential;
        const key = decodeCredentialPublicKey(credential.publicKey);
        if (
          !cose.isCOSEPublicKeyEC2(key) ||
          key.get(cose.COSEKEYS.alg) !== -7 ||
          key.get(cose.COSEKEYS.crv) !== 1
        )
          throw new EnrollmentRejected();
        const x = key.get(cose.COSEKEYS.x);
        const y = key.get(cose.COSEKEYS.y);
        if (!x || !y || x.length !== 32 || y.length !== 32) throw new EnrollmentRejected();
        const coordinates = {
          x: `0x${Buffer.from(x).toString("hex")}`,
          y: `0x${Buffer.from(y).toString("hex")}`,
        };
        const challenge = randomBytes(32).toString("base64url");
        const advanced = await db.query(
          "UPDATE account_enrollments SET status='prove', challenge=$2, credential=$3, coordinates=$4 WHERE id=$1 AND expires_at > clock_timestamp()",
          [
            row.id,
            challenge,
            JSON.stringify({
              ...credential,
              publicKey: Buffer.from(credential.publicKey).toString("base64url"),
            }),
            JSON.stringify(coordinates),
          ],
        );
        if (advanced.rowCount !== 1) throw new EnrollmentRejected();
        await db.query("COMMIT");
        return {
          status: "prove",
          options: {
            challenge,
            rpId: row.rp_id,
            allowCredentials: [{ id: credential.id, type: "public-key" }],
            userVerification: "required",
            timeout: 120_000,
          },
        };
      }
      const proof = response as AuthenticationResponseJSON;
      let newCounter: number;
      try {
        newCounter = await verifyStrictPasskeyAssertion({
          response: proof,
          credential: row.credential,
          challenge: row.challenge,
          rpId: row.rp_id,
          origin: row.origin,
        });
      } catch (error) {
        if (error instanceof PasskeyAssertionRejected) throw new EnrollmentRejected();
        throw error;
      }
      const advanced = await db.query(
        `UPDATE account_enrollments
         SET status='verified', verified_at=now(), challenge='',
             credential=jsonb_set(credential,'{counter}',to_jsonb($2::integer))
         WHERE id=$1 AND expires_at > clock_timestamp()`,
        [row.id, newCounter],
      );
      if (advanced.rowCount !== 1) throw new EnrollmentRejected();
      await db.query("COMMIT");
      return {
        status: "verified",
        enrollmentId: row.id,
        credentialId: row.credential.id,
        publicKey: row.coordinates,
        rpId: row.rp_id,
        origin: row.origin,
      };
    } catch (error) {
      await db.query("ROLLBACK");
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new EnrollmentRejected();
      throw error;
    } finally {
      db.release();
    }
  }
}
