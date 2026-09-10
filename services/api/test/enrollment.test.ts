import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  EnrollmentRejected,
  EnrollmentService,
  validateEnrollmentPolicy,
} from "../src/enrollment.js";

// Minimal CBOR fixture encoder; real verification and signature checking run in the service.
function cbor(value: number | string | Buffer | Map<unknown, unknown>): Buffer {
  const length = (major: number, size: number) =>
    size < 24 ? Buffer.from([major * 32 + size]) : Buffer.from([major * 32 + 24, size]);
  if (typeof value === "number") return length(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string")
    return Buffer.concat([length(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([length(2, value.length), value]);
  return Buffer.concat([
    length(5, value.size),
    ...[...value].flatMap(([key, item]) => [
      cbor(key as number | string),
      cbor(item as Parameters<typeof cbor>[0]),
    ]),
  ]);
}
const policy = { rpId: "localhost", origin: "http://localhost:3000" };
function fixture(challenge: string) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const key = cbor(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x as string, "base64url")],
      [-3, Buffer.from(jwk.y as string, "base64url")],
    ]),
  );
  const rp = createHash("sha256").update(policy.rpId).digest();
  const client = (type: string, challenge: string, origin = policy.origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const auth = Buffer.concat([
    rp,
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    Buffer.from([0, id.length]),
    id,
    key,
  ]);
  const registration: RegistrationResponseJSON = {
    id: id.toString("base64url"),
    rawId: id.toString("base64url"),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: client("webauthn.create", challenge).toString("base64url"),
      attestationObject: cbor(
        new Map<unknown, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", auth],
        ]),
      ).toString("base64url"),
    },
  };
  function proof(challenge: string, origin = policy.origin, flags = 5): AuthenticationResponseJSON {
    const data = client("webauthn.get", challenge, origin);
    const auth = Buffer.concat([rp, Buffer.from([flags]), Buffer.alloc(4)]);
    return {
      id: registration.id,
      rawId: registration.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: data.toString("base64url"),
        authenticatorData: auth.toString("base64url"),
        signature: sign(
          "sha256",
          Buffer.concat([auth, createHash("sha256").update(data).digest()]),
          keys.privateKey,
        ).toString("base64url"),
      },
    };
  }
  return {
    registration,
    proof,
    x: `0x${Buffer.from(jwk.x as string, "base64url").toString("hex")}`,
  };
}

it("rejects insecure, mismatched and noncanonical origin policies", () => {
  expect(validateEnrollmentPolicy(policy)).toEqual(policy);
  for (const origin of [
    "http://example.com",
    "https://evil.localhost.invalid",
    "http://localhost:3000/",
  ])
    expect(() => validateEnrollmentPolicy({ ...policy, origin })).toThrow();
});

describe.skipIf(!process.env.ENROLLMENT_TEST_DATABASE_URL)(
  "PostgreSQL enrollment ceremonies",
  () => {
    let pool: Pool;
    let service: EnrollmentService;
    const schema = `enrollment_test_${randomBytes(8).toString("hex")}`;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.ENROLLMENT_TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
        max: 5,
      });
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        await readFile(new URL("../migrations/001_enrollment.sql", import.meta.url), "utf8"),
      );
      service = new EnrollmentService(pool, policy);
    });
    afterAll(async () => {
      if (pool) {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        await pool.end();
      }
    });

    it("persists across service restart, verifies key possession and rejects concurrent replay", async () => {
      const start = await service.begin();
      const f = fixture(start.options.challenge);
      const registered = await service.verify(start.token, "register", f.registration);
      if (!registered.options) throw new Error("Missing proof options");
      const restarted = new EnrollmentService(pool, policy);
      const results = await Promise.allSettled([
        restarted.verify(start.token, "prove", f.proof(registered.options.challenge)),
        service.verify(start.token, "prove", f.proof(registered.options.challenge)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const success = results.find((r) => r.status === "fulfilled");
      if (success?.status !== "fulfilled") throw new Error("Missing verified enrollment");
      expect(success.value.publicKey.x).toBe(f.x);
      await expect(service.verify(start.token, "register", f.registration)).rejects.toBeInstanceOf(
        EnrollmentRejected,
      );
    });

    it("rejects wrong challenge, origin, missing verification and forged signatures without advancing state", async () => {
      const start = await service.begin();
      const f = fixture(start.options.challenge);
      const registered = await service.verify(start.token, "register", f.registration);
      if (!registered.options) throw new Error("Missing proof options");
      const challenge = registered.options.challenge;
      const forged = f.proof(challenge);
      forged.response.signature = randomBytes(70).toString("base64url");
      for (const proof of [
        f.proof("wrong"),
        f.proof(challenge, "https://evil.invalid"),
        f.proof(challenge, policy.origin, 1),
        forged,
      ])
        await expect(service.verify(start.token, "prove", proof)).rejects.toBeInstanceOf(
          EnrollmentRejected,
        );
      expect((await service.verify(start.token, "prove", f.proof(challenge))).status).toBe(
        "verified",
      );
    });

    it("rejects expired and foreign tokens and cross-origin API calls", async () => {
      const start = await service.begin();
      const f = fixture(start.options.challenge);
      await pool.query(
        "UPDATE account_enrollments SET expires_at=now()-interval '1 second' WHERE challenge=$1",
        [start.options.challenge],
      );
      await expect(service.verify(start.token, "register", f.registration)).rejects.toBeInstanceOf(
        EnrollmentRejected,
      );
      await expect(
        service.verify(randomBytes(32).toString("base64url"), "register", f.registration),
      ).rejects.toBeInstanceOf(EnrollmentRejected);
      const app = await buildApp(service, policy.origin);
      const rejected = await app.inject({
        method: "POST",
        url: "/v1/accounts/enrollment-challenges",
        headers: { origin: "https://evil.invalid" },
        payload: {},
      });
      expect(rejected.statusCode).toBe(403);
      const allowed = await app.inject({
        method: "POST",
        url: "/v1/accounts/enrollment-challenges",
        headers: { origin: policy.origin },
        payload: {},
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers["cache-control"]).toBe("no-store");
      await app.close();
    });
  },
);
