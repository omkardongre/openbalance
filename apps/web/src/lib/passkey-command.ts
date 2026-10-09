import type { WebAuthnAuth } from "@openbalance/protocol";
import { startAuthentication } from "@simplewebauthn/browser";
import { type Hex, hexToBytes, toHex } from "viem";

const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER / 2n;

function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function readLength(bytes: Uint8Array, offset: number): [number, number] {
  const first = bytes[offset];
  if (first === undefined) throw new Error("Passkey signature is truncated.");
  if (first < 0x80) return [first, offset + 1];
  const lengthBytes = first & 0x7f;
  if (lengthBytes < 1 || lengthBytes > 2) throw new Error("Passkey signature length is invalid.");
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    const value = bytes[offset + 1 + index];
    if (value === undefined) throw new Error("Passkey signature is truncated.");
    length = length * 256 + value;
  }
  return [length, offset + 1 + lengthBytes];
}

function integer(bytes: Uint8Array, offset: number): [Hex, number] {
  if (bytes[offset] !== 0x02) throw new Error("Passkey signature integer is invalid.");
  const [length, start] = readLength(bytes, offset + 1);
  let value = bytes.slice(start, start + length);
  if (value.length !== length) throw new Error("Passkey signature is truncated.");
  // A DER INTEGER with its top bit set is negative; r and s are positive, so a value of 2^255 or
  // more carries a 0x00 pad byte. Check the sign on the encoded bytes, then drop the pad.
  if (value.length < 1 || (value[0] ?? 0) >= 0x80)
    throw new Error("Passkey signature integer is out of range.");
  while (value.length > 1 && value[0] === 0) value = value.slice(1);
  if (value.length > 32) throw new Error("Passkey signature integer is out of range.");
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return [toHex(padded), start + length];
}

function parseP256Signature(encoded: string): { r: Hex; s: Hex } {
  const bytes = decodeBase64url(encoded);
  if (bytes[0] !== 0x30) throw new Error("Passkey signature is not DER encoded.");
  const [length, body] = readLength(bytes, 1);
  if (body + length !== bytes.length) throw new Error("Passkey signature length does not match.");
  const [r, next] = integer(bytes, body);
  const [s, end] = integer(bytes, next);
  if (end !== bytes.length) throw new Error("Passkey signature has trailing data.");
  // Authenticators may return either of the two valid s values; the account's P-256 check accepts
  // only the lower one (malleability guard), and n - s verifies the same message and key.
  const value = BigInt(s);
  const low = value > P256_HALF_ORDER ? P256_ORDER - value : value;
  return { r, s: toHex(low, { size: 32 }) };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function signAccountCommand(input: {
  digest: Hex;
  credentialId: string;
  rpId: string;
  origin: string;
}): Promise<WebAuthnAuth> {
  if (
    window.location.origin !== input.origin ||
    (window.location.hostname !== input.rpId &&
      !window.location.hostname.endsWith(`.${input.rpId}`))
  )
    throw new Error("This passkey is not valid for the current site.");
  const challenge = base64url(hexToBytes(input.digest));
  const expected = JSON.stringify({ type: "webauthn.get", challenge, origin: input.origin });
  const accepted = (value: string) =>
    value === expected || value === `${expected.slice(0, -1)},"crossOrigin":false}`;
  // Chromium randomly appends an anti-templating member ("other_keys_can_be_added_here") to
  // clientDataJSON. The on-chain verifier accepts only the standard serialization, so such an
  // assertion can never verify; asking again yields a standard one. Bounded so a browser that
  // always deviates still fails clearly.
  let assertion: Awaited<ReturnType<typeof startAuthentication>> | undefined;
  let clientDataJSON = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    assertion = await startAuthentication({
      optionsJSON: {
        challenge,
        rpId: input.rpId,
        allowCredentials: [{ id: input.credentialId, type: "public-key" }],
        userVerification: "required",
        timeout: 120_000,
      },
    });
    clientDataJSON = new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64url(assertion.response.clientDataJSON),
    );
    if (accepted(clientDataJSON) || !clientDataJSON.includes("other_keys_can_be_added_here")) break;
  }
  if (!assertion || !accepted(clientDataJSON))
    throw new Error("Passkey client data is outside the supported security profile.");
  const authenticatorData = decodeBase64url(assertion.response.authenticatorData);
  const flags = authenticatorData[32] ?? 0;
  if (
    authenticatorData.length !== 37 ||
    (flags & 5) !== 5 ||
    (flags & 0xe2) !== 0 ||
    ((flags & 8) === 0 && (flags & 16) !== 0)
  )
    throw new Error("Passkey authenticator data is outside the supported security profile.");
  return {
    ...parseP256Signature(assertion.response.signature),
    challengeIndex: 23n,
    typeIndex: 1n,
    authenticatorData: toHex(authenticatorData),
    clientDataJSON,
  };
}
