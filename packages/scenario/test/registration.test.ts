import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { VirtualAuthenticator } from "../src/authenticator.js";

const rpId = "localhost";
const origin = "http://localhost:3000";
const challenge = `0x${"cd".repeat(32)}` as const;
const challengeString = Buffer.from(challenge.slice(2), "hex").toString("base64url");

describe("VirtualAuthenticator registration", () => {
  it("produces an attestation the passkey server verifies", async () => {
    const authenticator = VirtualAuthenticator.create({ rpId, origin });
    const registration = authenticator.registration(challenge);
    const verified = await verifyRegistrationResponse({
      response: registration,
      expectedChallenge: challengeString,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    expect(verified.verified).toBe(true);
    expect(verified.registrationInfo?.credential.id).toBe(
      Buffer.from(authenticator.credentialId.slice(2), "hex").toString("base64url"),
    );
  });

  it("rejects a registration presented for another origin", async () => {
    const authenticator = VirtualAuthenticator.create({ rpId, origin });
    const registration = authenticator.registration(challenge);
    const verified = await verifyRegistrationResponse({
      response: registration,
      expectedChallenge: challengeString,
      expectedOrigin: "https://evil.example",
      expectedRPID: rpId,
      requireUserVerification: true,
    }).catch(() => ({ verified: false }));
    expect(verified.verified).toBe(false);
  });
});
