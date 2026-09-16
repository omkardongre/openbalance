import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VirtualAuthenticator } from "../src/authenticator.js";

const rpId = "localhost";
const origin = "http://localhost:3000";
const challenge = `0x${"ab".repeat(32)}` as const;

describe("VirtualAuthenticator", () => {
  it("produces the strict assertion profile the account contract accepts", () => {
    const authenticator = VirtualAuthenticator.create({ rpId, origin });
    const assertion = authenticator.assert(challenge);

    expect(authenticator.rpIdHash).toBe(`0x${createHash("sha256").update(rpId).digest("hex")}`);
    expect(assertion.clientDataJSON).toBe(
      `{"type":"webauthn.get","challenge":"${Buffer.from(challenge.slice(2), "hex").toString("base64url")}","origin":"${origin}"}`,
    );

    const authenticatorData = Buffer.from(assertion.authenticatorData.slice(2), "hex");
    expect(authenticatorData.byteLength).toBe(37);
    expect(authenticatorData.subarray(0, 32).toString("hex")).toBe(authenticator.rpIdHash.slice(2));
    expect(authenticatorData[32]).toBe(0x05);

    const s = BigInt(assertion.s);
    expect(s).toBeLessThanOrEqual(
      BigInt("0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8"),
    );
  });

  it("signs a message that verifies against its own public key", () => {
    const authenticator = VirtualAuthenticator.create({ rpId, origin });
    const assertion = authenticator.assert(challenge);
    const authenticatorData = Buffer.from(assertion.authenticatorData.slice(2), "hex");
    const clientHash = createHash("sha256").update(assertion.clientDataJSON, "utf8").digest();
    const message = Buffer.concat([authenticatorData, clientHash]);
    const signature = Buffer.concat([
      Buffer.from(assertion.r.slice(2), "hex"),
      Buffer.from(assertion.s.slice(2), "hex"),
    ]);
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64(authenticator.publicKey.x),
        y: b64(authenticator.publicKey.y),
      },
      format: "jwk",
    });
    expect(
      cryptoVerify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
    ).toBe(true);
  });

  it("restores identical signing material across a process restart", () => {
    const original = VirtualAuthenticator.create({ rpId, origin });
    const restored = VirtualAuthenticator.restore(JSON.parse(JSON.stringify(original.toJSON())));
    expect(restored.publicKey).toEqual(original.publicKey);
    expect(restored.rpIdHash).toBe(original.rpIdHash);
    const assertion = restored.assert(challenge);
    expect(Buffer.from(assertion.authenticatorData.slice(2), "hex").byteLength).toBe(37);
  });

  it("rejects a non-canonical origin", () => {
    expect(() => VirtualAuthenticator.create({ rpId, origin: 'http://evil/"x' })).toThrow();
  });
});

function b64(value: string): string {
  return Buffer.from(value.slice(2), "hex").toString("base64url");
}
