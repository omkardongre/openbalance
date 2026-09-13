import type { WebAuthnAuth } from "@openbalance/protocol";
import { startAuthentication } from "@simplewebauthn/browser";
import { type Hex, hexToBytes, toHex } from "viem";

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
  while (value.length > 32 && value[0] === 0) value = value.slice(1);
  if (value.length < 1 || value.length > 32 || (value[0] ?? 0) >= 0x80)
    throw new Error("Passkey signature integer is out of range.");
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
  return { r, s };
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
  const assertion = await startAuthentication({
    optionsJSON: {
      challenge,
      rpId: input.rpId,
      allowCredentials: [{ id: input.credentialId, type: "public-key" }],
      userVerification: "required",
      timeout: 120_000,
    },
  });
  const clientDataJSON = new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64url(assertion.response.clientDataJSON),
  );
  const expected = JSON.stringify({ type: "webauthn.get", challenge, origin: input.origin });
  if (
    clientDataJSON !== expected &&
    clientDataJSON !== `${expected.slice(0, -1)},"crossOrigin":false}`
  )
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
