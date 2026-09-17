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
const BASE64URL = /^[A-Za-z0-9_-]{1,512}$/;

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

/** Registration response in the shape `@simplewebauthn/server` verifies. */
export type WebAuthnRegistration = {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, never>;
  response: { clientDataJSON: string; attestationObject: string };
};

/** Authentication response in the shape `@simplewebauthn/server` verifies. */
export type WebAuthnAuthentication = {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
};

/** ASN.1 DER ECDSA signature, which is what browsers send and the passkey server expects. */
function derSignature(r: Buffer, s: Buffer): Buffer {
  const encodeInteger = (value: Buffer): Buffer => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    let bytes = value.subarray(start);
    if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([encodeInteger(r), encodeInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

function cborInt(value: number): Buffer {
  return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
}

function cborText(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([cborHead(3, bytes.byteLength), bytes]);
}

function cborBytes(value: Buffer): Buffer {
  return Buffer.concat([cborHead(2, value.byteLength), value]);
}

function cborMap(entries: [Buffer, Buffer][]): Buffer {
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);
}

/** ES256 COSE key for a P-256 public key. */
function cosePublicKey(x: Buffer, y: Buffer): Buffer {
  return cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ]);
}

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
    return this.assertBase64Url(base64Url(Buffer.from(challenge.slice(2), "hex")));
  }

  /** Produces the strict assertion for a challenge already encoded as base64url. */
  assertBase64Url(challenge: string): WebAuthnAssertion {
    if (!BASE64URL.test(challenge)) throw new Error("Invalid WebAuthn challenge");
    const clientDataJSON = `{"type":"webauthn.get","challenge":"${challenge}","origin":"${this.origin}"}`;
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

  /** Produces the registration (attestation) response for a challenge. */
  registration(challenge: Hex): WebAuthnRegistration {
    if (!HEX_32.test(challenge)) throw new Error("Invalid WebAuthn challenge");
    return this.registrationBase64Url(base64Url(Buffer.from(challenge.slice(2), "hex")));
  }

  /** Produces the registration response for a challenge already encoded as base64url. */
  registrationBase64Url(challenge: string): WebAuthnRegistration {
    if (!BASE64URL.test(challenge)) throw new Error("Invalid WebAuthn challenge");
    const clientDataJSON = `{"type":"webauthn.create","challenge":"${challenge}","origin":"${this.origin}"}`;
    const credentialId = Buffer.from(this.credentialId.slice(2), "hex");
    const authData = Buffer.concat([
      Buffer.from(this.rpIdHash.slice(2), "hex"),
      Buffer.from([0x45]), // user present | user verified | attested credential data
      counterBytes(this.#signCount),
      Buffer.alloc(16),
      Buffer.from([(credentialId.byteLength >> 8) & 0xff, credentialId.byteLength & 0xff]),
      credentialId,
      cosePublicKey(
        Buffer.from(this.publicKey.x.slice(2), "hex"),
        Buffer.from(this.publicKey.y.slice(2), "hex"),
      ),
    ]);
    const attestationObject = cborMap([
      [cborText("fmt"), cborText("none")],
      [cborText("attStmt"), cborMap([])],
      [cborText("authData"), cborBytes(authData)],
    ]);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64Url(Buffer.from(clientDataJSON, "utf8")),
        attestationObject: base64Url(attestationObject),
      },
    };
  }

  /** Produces the authentication (assertion) response for a challenge. */
  authentication(challenge: Hex): WebAuthnAuthentication {
    if (!HEX_32.test(challenge)) throw new Error("Invalid WebAuthn challenge");
    return this.authenticationBase64Url(base64Url(Buffer.from(challenge.slice(2), "hex")));
  }

  /** Produces the authentication response for a challenge already encoded as base64url. */
  authenticationBase64Url(challenge: string): WebAuthnAuthentication {
    if (!BASE64URL.test(challenge)) throw new Error("Invalid WebAuthn challenge");
    const assertion = this.assertBase64Url(challenge);
    const credentialId = base64Url(Buffer.from(this.credentialId.slice(2), "hex"));
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64Url(Buffer.from(assertion.clientDataJSON, "utf8")),
        authenticatorData: base64Url(Buffer.from(assertion.authenticatorData.slice(2), "hex")),
        signature: base64Url(
          derSignature(
            Buffer.from(assertion.r.slice(2), "hex"),
            Buffer.from(assertion.s.slice(2), "hex"),
          ),
        ),
        userHandle: null,
      },
    };
  }
}

function counterBytes(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}
