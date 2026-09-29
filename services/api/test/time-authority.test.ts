import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { terminalTimePayload } from "@openbalance/protocol";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { TimeAuthority } from "../src/time-authority.js";

const nonce = "ab".repeat(32);

describe("terminal time authority", () => {
  it("signs the requested nonce with a key the terminal can pin from its DER export", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const authority = new TimeAuthority(privateKey, () => 1_800_000_000_000);
    const app = await buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      authority,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/terminal/time",
        payload: { nonce },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(["nonce", "signature", "uncertaintyMs", "unixMs"]);
      expect(body).toMatchObject({ nonce, unixMs: 1_800_000_000_000 });
      const pinned = createPublicKey({
        key: Buffer.from(authority.publicKeyDerBase64(), "base64"),
        format: "der",
        type: "spki",
      });
      const payload = Buffer.from(terminalTimePayload(body));
      expect(verify(null, payload, pinned, Buffer.from(body.signature, "hex"))).toBe(true);
      // Bound to this request: the same signature does not verify for any other nonce.
      const replayed = Buffer.from(terminalTimePayload({ ...body, nonce: "cd".repeat(32) }));
      expect(verify(null, replayed, pinned, Buffer.from(body.signature, "hex"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects a malformed nonce and a non-Ed25519 key", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const app = await buildApp(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new TimeAuthority(privateKey),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/terminal/time",
        payload: { nonce: "not-hex" },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
    const { privateKey: ecKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => new TimeAuthority(ecKey)).toThrow("Ed25519");
  });
});
