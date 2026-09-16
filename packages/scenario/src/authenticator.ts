import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import type { Hex } from "viem";

/// secp256r1 (P-256) group order.
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const HALF_ORDER = P256_ORDER >> 1n;

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;

/** Serialized key material so a scenario authenticator can survive a process restart. */
export type VirtualAuthenticatorState = {
  credentialId: Hex;
  rpIdHash: Hex;
  origin: string;
  signCount: number;
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
};

export type WebAuthnAssertion = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function hexOf(bytes: Buffer): Hex {
  return `0x${bytes.toString("hex")}` as Hex;
}

function jwkCoordinate(value: string | undefined, name: string): Hex {
  if (!value) throw new Error(`Virtual authenticator is missing its ${name} coordinate`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32)
    throw new Error(`Virtual authenticator ${name} coordinate is not 32 bytes`);
  return hexOf(bytes);
}

/**
 * Deterministic, software P-256 authenticator for local scenarios and browser automation.
 *
 * It reproduces the strict assertion profile the account contract accepts: a 37-byte
 * authenticator data block with only the user-present and user-verified flags, the exact
 * ordered client-data JSON, and a low-s ECDSA signature over the WebAuthn message. It has no
 * relationship to hardware-backed attestation and must never be used outside test environments.
 */
export class VirtualAuthenticator {
  readonly credentialId: Hex;
  readonly rpIdHash: Hex;
  readonly origin: string;
  readonly publicKey: { x: Hex; y: Hex };
  #privateKey: KeyObject;
  #signCount: number;

  private constructor(input: {
    credentialId: Hex;
    rpIdHash: Hex;
    origin: string;
    signCount: number;
    privateKey: KeyObject;
    publicKey: { x: Hex; y: Hex };
  }) {
    if (!HEX_32.test(input.credentialId)) throw new Error("Invalid credential identifier");
    if (!HEX_32.test(input.rpIdHash)) throw new Error("Invalid relying-party identifier hash");
    if (!HEX_32.test(input.publicKey.x) || !HEX_32.test(input.publicKey.y))
      throw new Error("Invalid virtual authenticator public key");
    if (input.origin.length === 0 || input.origin.length > 200)
      throw new Error("Invalid virtual authenticator origin");
    if (/["\\]/.test(input.origin))
      throw new Error("Virtual authenticator origin is not canonical");
    this.credentialId = input.credentialId;
    this.rpIdHash = input.rpIdHash;
    this.origin = input.origin;
    this.publicKey = input.publicKey;
    this.#privateKey = input.privateKey;
    this.#signCount = input.signCount;
  }

  /** Creates a fresh authenticator bound to a relying-party identifier and origin. */
  static create(input: { rpId: string; origin: string; credentialId?: Hex }): VirtualAuthenticator {
    const rpIdHash = hexOf(sha256(Buffer.from(input.rpId, "utf8")));
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey;
    return new VirtualAuthenticator({
      credentialId: input.credentialId ?? hexOf(sha256(Buffer.from(`credential:${input.rpId}`))),
      rpIdHash,
      origin: input.origin,
      signCount: 0,
      privateKey,
      publicKey: {
        x: jwkCoordinate(publicJwk.x, "x"),
        y: jwkCoordinate(publicJwk.y, "y"),
      },
    });
  }

  /** Restores a previously created authenticator from serialized state. */
  static restore(state: VirtualAuthenticatorState): VirtualAuthenticator {
    if (state.privateJwk.kty !== "EC" || state.privateJwk.crv !== "P-256")
      throw new Error("Unsupported virtual authenticator key material");
    return new VirtualAuthenticator({
      credentialId: state.credentialId,
      rpIdHash: state.rpIdHash,
      origin: state.origin,
      signCount: state.signCount,
      privateKey: createPrivateKey({ key: state.privateJwk, format: "jwk" }),
      publicKey: {
        x: jwkCoordinate(state.publicJwk.x, "x"),
        y: jwkCoordinate(state.publicJwk.y, "y"),
      },
    });
  }

  toJSON(): VirtualAuthenticatorState {
    const publicJwk = createPublicKey(this.#privateKey).export({ format: "jwk" }) as JsonWebKey;
    return {
      credentialId: this.credentialId,
      rpIdHash: this.rpIdHash,
      origin: this.origin,
      signCount: this.#signCount,
      privateJwk: this.#privateKey.export({ format: "jwk" }) as JsonWebKey,
      publicJwk,
    };
  }

  /** Produces the strict assertion for a 32-byte command digest. */
  assert(challenge: Hex): WebAuthnAssertion {
    if (!HEX_32.test(challenge)) throw new Error("Invalid WebAuthn challenge");
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64Url(
      Buffer.from(challenge.slice(2), "hex"),
    )}","origin":"${this.origin}"}`;
    const authenticatorData = Buffer.concat([
      Buffer.from(this.rpIdHash.slice(2), "hex"),
      Buffer.from([0x05]),
      counterBytes(this.#signCount),
    ]);
    this.#signCount += 1;
    const message = Buffer.concat([authenticatorData, sha256(Buffer.from(clientDataJSON, "utf8"))]);
    const raw = cryptoSign("sha256", message, {
      key: this.#privateKey,
      dsaEncoding: "ieee-p1363",
    });
    if (raw.byteLength !== 64) throw new Error("Unexpected P-256 signature length");
    const r = raw.subarray(0, 32);
    let s = BigInt(`0x${raw.subarray(32, 64).toString("hex")}`);
    if (s > HALF_ORDER) s = P256_ORDER - s;
    const sBytes = Buffer.from(s.toString(16).padStart(64, "0"), "hex");
    return {
      r: hexOf(r),
      s: hexOf(sBytes),
      challengeIndex: 0n,
      typeIndex: 0n,
      authenticatorData: hexOf(authenticatorData),
      clientDataJSON,
    };
  }
}

function counterBytes(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}
