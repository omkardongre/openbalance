import { createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { terminalTimePayload } from "@openbalance/protocol";

/**
 * Error bound published with every sample. Cloud Run hosts are disciplined by Google's NTP service
 * to well under this; the terminal widens its window by the bound plus the request round trip, so
 * overstating it only narrows how long a sale may run, while understating it would be unsafe.
 */
const UNCERTAINTY_MS = 1_000;

export type TimeAttestation = {
  nonce: string;
  unixMs: number;
  uncertaintyMs: number;
  signature: string;
};

/**
 * Signs the current wall-clock time over a terminal-chosen nonce. A terminal accepts offline sales
 * only inside windows measured from such a sample, so a device clock that was set back or forward
 * cannot stretch a reserve's acceptance window. The nonce binds each answer to one request, so a
 * recorded answer cannot be replayed later to pin a terminal to a stale time.
 */
export class TimeAuthority {
  readonly #key: KeyObject;
  readonly #now: () => number;

  constructor(key: KeyObject, now: () => number = Date.now) {
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
      throw new Error("Time authority key must be an Ed25519 private key");
    this.#key = key;
    this.#now = now;
  }

  /** DER-encoded SubjectPublicKeyInfo, base64. This is the value pinned into terminal builds. */
  publicKeyDerBase64(): string {
    return createPublicKey(this.#key).export({ type: "spki", format: "der" }).toString("base64");
  }

  attest(nonce: string): TimeAttestation {
    const unixMs = this.#now();
    const payload = terminalTimePayload({ nonce, unixMs, uncertaintyMs: UNCERTAINTY_MS });
    const signature = sign(null, Buffer.from(payload, "utf8"), this.#key).toString("hex");
    return { nonce, unixMs, uncertaintyMs: UNCERTAINTY_MS, signature };
  }
}

/** Loads a PKCS#8 PEM Ed25519 private key from a mounted secret file. */
export async function loadTimeAuthority(path: string): Promise<TimeAuthority> {
  return new TimeAuthority(createPrivateKey(await readFile(path, "utf8")));
}
