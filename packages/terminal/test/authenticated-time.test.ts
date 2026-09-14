import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { SignedHttpsTimeSource, timeAttestationPayload } from "../src/authenticated-time.js";

it("binds time to a fresh challenge, pinned key, round trip and device boot", async () => {
  const keys = generateKeyPairSync("ed25519");
  let monotonicMs = 1_000;
  let bootId = "boot:one";
  let mode = "valid";
  const source = new SignedHttpsTimeSource(
    "https://clock.example/time",
    keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    { read: () => ({ monotonicMs, bootId }) },
    500,
    async (_url, options) => {
      const nonce = JSON.parse(options?.body as string).nonce;
      const sample = { nonce, unixMs: 100_000, uncertaintyMs: 20 };
      const signature = sign(
        null,
        Buffer.from(timeAttestationPayload(sample)),
        keys.privateKey,
      ).toString("hex");
      monotonicMs += 100;
      if (mode === "reboot") bootId = "boot:two";
      if (mode === "tamper") sample.unixMs++;
      if (mode === "replay") sample.nonce = "a".repeat(64);
      return new Response(JSON.stringify({ ...sample, signature }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  expect(await source.sample()).toEqual({
    earliestUnixMs: 99_980,
    latestUnixMs: 100_120,
    observedMonotonicMs: 1_100,
    bootId: "boot:one",
  });
  for (const failure of ["tamper", "replay", "reboot"]) {
    mode = failure;
    await expect(source.sample()).rejects.toThrow();
  }
});
