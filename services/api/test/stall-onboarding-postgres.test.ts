import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { encodeAbiParameters, keccak256, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { CheckoutService, CheckoutTerminalPending } from "../src/checkout.js";
import type { CheckoutManifest } from "../src/checkout-manifest.js";
import { OperationsAccessService } from "../src/operations-access.js";
import {
  destinationApprovalTypedData,
  StallConflict,
  StallNotFound,
  StallOnboardingService,
  type StallRegistryView,
  StallRejected,
} from "../src/stall-onboarding.js";

const databaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
const eligible = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && url.pathname.includes("test");
})();
const postgresIt = eligible ? it : it.skip;
const hex = (digit: string) => `0x${digit.repeat(64)}` as const;
const address = (digit: string) => `0x${digit.repeat(40)}` as const;
const zero = "0x0000000000000000000000000000000000000000" as const;

postgresIt(
  "onboards a stall from invite to live only as far as the registry shows",
  async () => {
    if (!databaseUrl) throw new Error("Missing isolated operations test database");
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const streamId = `test:10143:${randomUUID()}`;
    const eventId = hex("e");
    const registry = address("2");
    const owner = privateKeyToAccount(`0x${"21".repeat(32)}`);
    const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const terminalKey = privateKeyToAccount(`0x${"23".repeat(32)}`);
    const payout = address("9");
    const manifest: CheckoutManifest = {
      schemaVersion: 1,
      chainId: 10_143,
      events: [
        {
          streamId,
          eventId,
          router: address("1"),
          registry,
          ledger: address("5"),
          vault: address("3"),
          runtimeCodeHashes: {
            registry: hex("1"),
            ledger: hex("2"),
            router: hex("3"),
            vault: hex("4"),
          },
          asset: address("4"),
          assetSymbol: "USDC",
          assetDecimals: 6,
          configVersion: 1n,
          organizerFeeBps: 200,
          platformFeeBps: 100,
          intentLifetimeSeconds: 600,
          vendors: [],
        },
      ],
    };
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const view: StallRegistryView = {
      vendor: { authority: zero, enabled: false },
      destination: { account: zero, enabled: false },
      terminal: { vendorId: hex("0"), signer: zero, validAfter: 0, validUntil: 0, enabled: false },
      config: { validAfter: nowSeconds - 100, validUntil: nowSeconds + 86_400, enabled: true },
    };
    const stalls = new StallOnboardingService(
      pool,
      manifest,
      { read: async () => view },
      () => now,
    );
    const checkout = new CheckoutService(
      pool,
      manifest,
      { assert: async () => undefined },
      Buffer.alloc(32, 7),
      () => now,
      stalls,
    );
    const organizer = {
      credentialId: randomUUID(),
      principalId: `organizer:${randomUUID()}`,
      role: "ORGANIZER" as const,
      streamId,
      eventId,
      vendorId: null,
    };
    const deadline = BigInt(nowSeconds + 7 * 86_400);
    const sign = (signer: typeof owner, vendorId: `0x${string}`) =>
      signer.signTypedData(
        destinationApprovalTypedData({
          chainId: 10_143,
          registry,
          vendorId,
          version: 1n,
          destination: payout,
          deadline,
        }),
      );
    try {
      await expect(
        stalls.createInvite({ ...organizer, role: "VENDOR" }, "x"),
      ).rejects.toBeInstanceOf(StallRejected);
      const { stall, inviteToken } = await stalls.createInvite(organizer, "Taco truck by gate B");
      expect(stall.state).toBe("INVITED");
      const invite = await stalls.lookupInvite(inviteToken);
      expect(invite).toMatchObject({ registry, vendorId: stall.vendorId, chainId: 10_143 });

      const submission = {
        stallName: "Taco Truck",
        category: "Food",
        authority: owner.address,
        payoutAddress: payout,
        deadline,
      };
      // A signature from anyone but the declared authority is refused, and the invite survives.
      await expect(
        stalls.submitInvite(inviteToken, {
          ...submission,
          signature: await sign(stranger, stall.vendorId),
        }),
      ).rejects.toBeInstanceOf(StallRejected);
      await stalls.submitInvite(inviteToken, {
        ...submission,
        signature: await sign(owner, stall.vendorId),
      });
      // Single use as a form; afterwards the same link is the owner's status page.
      await expect(
        stalls.submitInvite(inviteToken, {
          ...submission,
          signature: await sign(owner, stall.vendorId),
        }),
      ).rejects.toBeInstanceOf(StallNotFound);
      expect(await stalls.lookupInvite(inviteToken)).toMatchObject({
        state: "SUBMITTED",
        stallName: "Taco Truck",
        pairing: null,
      });
      // No setup code for the owner before the organizer registered the stall.
      await expect(stalls.issueOwnerSetupCode(inviteToken)).rejects.toBeInstanceOf(StallConflict);
      await expect(stalls.lookupInvite("A".repeat(43))).rejects.toBeInstanceOf(StallNotFound);

      // Nothing on chain yet: stays submitted and is not listed for attendees.
      expect((await stalls.refresh(organizer, stall.stallId)).stall.state).toBe("SUBMITTED");
      view.vendor = { authority: owner.address, enabled: true };
      view.destination = { account: payout, enabled: true };
      const approved = await stalls.refresh(organizer, stall.stallId);
      expect(approved.stall.state).toBe("APPROVED");
      expect(approved.registry?.terminalWindow.validUntil).toBe(view.config.validUntil);
      expect((await checkout.reserveTerms()).events[0]?.vendors).toEqual([]);

      expect(await stalls.lookupInvite(inviteToken)).toMatchObject({
        state: "APPROVED",
        pairing: "NEEDS_PHONE",
      });
      // The paired device proves its key; it is recorded but cannot sync until registered. The
      // owner shows the setup code from their own link, without the organizer.
      const code = await stalls.issueOwnerSetupCode(inviteToken);
      const access = new OperationsAccessService(pool);
      const vendor = await access.authenticate(`Bearer ${code.accessToken}`);
      expect(vendor).toMatchObject({ role: "VENDOR", vendorId: stall.vendorId });
      const challenge = await checkout.beginTerminalProvisioning(vendor);
      expect(challenge.terminalInstanceId).toBe(stall.terminal.instanceId);
      const digest = keccak256(
        encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "uint256" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "bytes32" },
          ],
          [
            keccak256(stringToHex("openbalance:terminal-provisioning:v1")),
            10_143n,
            eventId,
            stall.terminal.instanceId,
            toHex(Buffer.from(challenge.challenge, "base64url"), { size: 32 }),
          ],
        ),
      );
      await expect(
        checkout.terminalProvisioning(
          vendor,
          challenge.challenge,
          await terminalKey.sign({ hash: digest }),
        ),
      ).rejects.toBeInstanceOf(CheckoutTerminalPending);
      const pending = (await stalls.list(organizer)).items[0];
      expect(pending?.terminal.pendingSigner).toBe(terminalKey.address);
      expect((await stalls.lookupInvite(inviteToken)).pairing).toBe("CHECKED_IN");

      view.terminal = {
        vendorId: stall.vendorId,
        signer: terminalKey.address,
        validAfter: nowSeconds - 60,
        validUntil: view.config.validUntil,
        enabled: true,
      };
      const live = await stalls.refresh(organizer, stall.stallId);
      expect(live.stall).toMatchObject({
        state: "LIVE",
        terminal: { signer: terminalKey.address },
      });
      expect((await checkout.reserveTerms()).events[0]?.vendors).toMatchObject([
        {
          vendorId: stall.vendorId,
          vendorName: "Taco Truck",
          terminal: { signer: terminalKey.address },
        },
      ]);

      expect(await stalls.lookupInvite(inviteToken)).toMatchObject({
        state: "LIVE",
        pairing: null,
      });
      // A live stall with its own phone is re-paired by the organizer only.
      await expect(stalls.issueOwnerSetupCode(inviteToken)).rejects.toBeInstanceOf(StallConflict);

      // Re-issuing the setup code revokes the earlier one.
      await stalls.issueSetupCode(organizer, stall.stallId);
      await expect(access.authenticate(`Bearer ${code.accessToken}`)).rejects.toThrow();
    } finally {
      await pool.query(
        `DELETE FROM operations_access_credentials WHERE principal_id IN
           (SELECT 'stall:' || stall_id FROM stall_onboarding WHERE stream_id=$1)`,
        [streamId],
      );
      await pool.query("DELETE FROM terminal_provisioning_challenges WHERE stream_id=$1", [
        streamId,
      ]);
      await pool.query("DELETE FROM stall_onboarding WHERE stream_id=$1", [streamId]);
      await pool.end();
    }
  },
  20_000,
);
