import {
  type AuthenticationResponseJSON,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

export class PasskeyAssertionRejected extends Error {}

type StoredCredential = {
  id: string;
  publicKey: string;
  counter: number;
};

export async function verifyStrictPasskeyAssertion(input: {
  response: AuthenticationResponseJSON;
  credential: StoredCredential;
  challenge: string;
  rpId: string;
  origin: string;
}) {
  try {
    const { response, credential, challenge, rpId, origin } = input;
    if (response.id !== credential.id || response.rawId !== credential.id)
      throw new PasskeyAssertionRejected();
    const clientData = Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8");
    const client = JSON.parse(clientData) as Record<string, unknown>;
    if (
      !client ||
      typeof client !== "object" ||
      (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
      client.topOrigin !== undefined
    )
      throw new PasskeyAssertionRejected();
    const authenticatorData = Buffer.from(response.response.authenticatorData ?? "", "base64url");
    const flags = authenticatorData[32] ?? 0;
    const expected = JSON.stringify({ type: "webauthn.get", challenge, origin });
    if (
      authenticatorData.length !== 37 ||
      (flags & 5) !== 5 ||
      (flags & 0xe2) !== 0 ||
      ((flags & 8) === 0 && (flags & 16) !== 0) ||
      Buffer.byteLength(clientData) > 512 ||
      (clientData !== expected && clientData !== `${expected.slice(0, -1)},"crossOrigin":false}`)
    )
      throw new PasskeyAssertionRejected();
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        ...credential,
        publicKey: Buffer.from(credential.publicKey, "base64url"),
      },
    });
    if (!verified.verified) throw new PasskeyAssertionRejected();
    return verified.authenticationInfo.newCounter;
  } catch {
    throw new PasskeyAssertionRejected();
  }
}
