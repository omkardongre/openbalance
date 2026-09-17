import {
  type AuthenticationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
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

  it("produces an assertion the passkey server verifies with a DER signature", async () => {
    const authenticator = VirtualAuthenticator.create({ rpId, origin });
    const registration = await verifyRegistrationResponse({
      response: authenticator.registration(challenge),
      expectedChallenge: challengeString,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    const credential = registration.registrationInfo?.credential;
    expect(credential).toBeDefined();

    const assertionChallenge = `0x${"ef".repeat(32)}` as const;
    const assertion = authenticator.authentication(assertionChallenge);
    expect(assertion.response.clientDataJSON).toBe(
      Buffer.from(
        `{"type":"webauthn.get","challenge":"${Buffer.from(assertionChallenge.slice(2), "hex").toString("base64url")}","origin":"${origin}"}`,
        "utf8",
      ).toString("base64url"),
    );
    expect(Buffer.from(assertion.response.authenticatorData, "base64url").byteLength).toBe(37);

    const verified = await verifyAuthenticationResponse({
      response: assertion as unknown as AuthenticationResponseJSON,
      expectedChallenge: Buffer.from(assertionChallenge.slice(2), "hex").toString("base64url"),
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: credential?.id ?? "",
        publicKey: credential?.publicKey ?? new Uint8Array(),
        counter: credential?.counter ?? 0,
      },
    });
    expect(verified.verified).toBe(true);
  });
});
