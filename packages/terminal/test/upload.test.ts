import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { VenueRelayJournal } from "@openbalance/venue-relay";
import { buildVenueRelayApp } from "@openbalance/venue-relay/app";
import { expect, it } from "vitest";
import { RelayUploadClient } from "../src/upload.js";
import { acceptSale, config, createJournal, terminal } from "./fixtures.js";

it("recovers an uncertain relay acknowledgement without duplicating the receipt", async () => {
  const fixture = createJournal();
  const relayJournal = new VenueRelayJournal(":memory:", randomBytes(32));
  const audience = "https://relay.example/v1/vouchers";
  const app = await buildVenueRelayApp({
    journal: relayJournal,
    audience,
    now: () => now,
    directory: {
      resolve: async () => ({
        signer: terminal.address,
        enabled: true,
        validAfter: 50,
        validUntil: 250,
      }),
    },
  });
  let now = 112_000;
  let disconnectAfterCommit = true;
  try {
    const sale = await acceptSale(fixture.journal, "c");
    const injectedFetch: typeof fetch = async (_input, init) => {
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      const response = await app.inject({
        method: "POST",
        url: "/v1/vouchers",
        payload: init?.body as string,
        headers: { "content-type": "application/json" },
      });
      if (disconnectAfterCommit) {
        disconnectAfterCommit = false;
        throw new Error("connection closed after request commit");
      }
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    };
    const uploader = new RelayUploadClient({
      journal: fixture.journal,
      endpoint: audience,
      audience,
      keyVersion: 1n,
      signer: terminal,
      owner: "terminal-uploader",
      fetch: injectedFetch,
      now: () => now,
    });
    await expect(uploader.runBatch(10)).resolves.toEqual([
      { requestId: sale.requestId, state: "RETRY", statusCode: null },
    ]);
    expect(relayJournal.get(sale.receipt?.receiptId ?? "").state).toBe("PENDING");

    now = 115_000;
    await expect(uploader.runBatch(10)).resolves.toEqual([
      { requestId: sale.requestId, state: "UPLOADED", statusCode: 200 },
    ]);
    expect(fixture.journal.getSale(sale.requestId).state).toBe("UPLOADED");
    expect(relayJournal.get(sale.receipt?.receiptId ?? "").receipt).toEqual(sale.receipt);
  } finally {
    await app.close();
    relayJournal.close();
    fixture.journal.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

it("quarantines permanent relay rejection and does not upload a later channel sequence", async () => {
  const fixture = createJournal();
  try {
    const first = await acceptSale(fixture.journal, "c");
    await acceptSale(fixture.journal, "d");
    const uploader = new RelayUploadClient({
      journal: fixture.journal,
      endpoint: "https://relay.example/v1/vouchers",
      audience: "https://relay.example/v1/vouchers",
      keyVersion: config.terminalKeyVersion,
      signer: terminal,
      owner: "terminal-uploader",
      fetch: async () => new Response('{"error":"voucher_conflict"}', { status: 409 }),
      now: () => 120_000,
    });
    await expect(uploader.runBatch(10)).resolves.toEqual([
      { requestId: first.requestId, state: "QUARANTINED", statusCode: 409 },
    ]);
    expect(fixture.journal.leaseUploads(10, "other", 200_000, 30_000)).toEqual([]);
  } finally {
    fixture.journal.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
