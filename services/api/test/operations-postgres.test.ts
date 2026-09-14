import { createHash, randomUUID } from "node:crypto";
import { decodePaymentIntent, paymentIntentDigest } from "@openbalance/protocol";
import { Pool } from "pg";
import { encodeAbiParameters, getAddress, keccak256, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { CheckoutConflict, CheckoutService } from "../src/checkout.js";
import type { CheckoutPolicyVerifier } from "../src/checkout-chain.js";
import type { CheckoutManifest } from "../src/checkout-manifest.js";
import { IncidentService } from "../src/incidents.js";
import { OperationsAccessService } from "../src/operations-access.js";
import { OperationsReportingService } from "../src/operations-reporting.js";
import {
  OrganizerConfigurationConflict,
  OrganizerConfigurationService,
} from "../src/organizer-configuration.js";
import type {
  OrganizerConfigurationChain,
  PreparedOrganizerCommand,
} from "../src/organizer-configuration-chain.js";

const databaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
const eligible = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && url.pathname.includes("test");
})();
const postgresIt = eligible ? it : it.skip;
const hex = (digit: string) => `0x${digit.repeat(64)}` as const;
const address = (digit: string) => `0x${digit.repeat(40)}` as const;

postgresIt(
  "keeps reporting and incident actions scoped, exact, and idempotent in PostgreSQL",
  async () => {
    if (!databaseUrl) throw new Error("Missing isolated operations test database");
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const eventId = hex("1");
    const vendorId = hex("2");
    const transitionId = `payment:${randomUUID()}`;
    const streamId = `test:10143:${randomUUID()}`;
    const token = "a".repeat(43);
    const principalId = `organizer:${randomUUID()}`;
    const credentialId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO indexer_cursors
          (stream_id,chain_id,deployment_block,block_number,block_hash) VALUES ($1,10143,10,10,$2)`,
        [streamId, hex("3")],
      );
      await pool.query(
        `INSERT INTO finalized_chain_logs
          (transition_id,stream_id,chain_id,event_id,contract_address,block_number,block_hash,
           transaction_hash,transaction_index,log_index,transition_kind,payload)
         VALUES ($1,$2,10143,$3,$4,10,$5,$6,0,0,'PAYMENT_COMMITTED','{}')`,
        [transitionId, streamId, eventId, `0x${"4".repeat(40)}`, hex("3"), hex("5")],
      );
      await pool.query(
        `INSERT INTO payment_projections
          (stream_id,payment_id,mode,payer,vendor_id,gross_units,organizer_fee_units,
           platform_fee_units,allocation_status,transition_id,transaction_hash,block_number)
         VALUES ($1,$2,'ONLINE',$3,$4,100,4,1,'EVENT_VERIFIED',$5,$6,10)`,
        [streamId, hex("6"), `0x${"7".repeat(40)}`, vendorId, transitionId, hex("5")],
      );
      await pool.query(
        `INSERT INTO operations_vendor_beneficiaries
          (stream_id,event_id,vendor_id,beneficiary_id,destination,approved_reference,valid_from_block)
         VALUES ($1,$2,$3,$4,$5,'destination:v1',0)`,
        [streamId, eventId, vendorId, hex("8"), `0x${"9".repeat(40)}`],
      );
      await pool.query(
        `INSERT INTO operations_access_credentials
          (credential_id,token_hash,principal_id,role,stream_id,event_id,expires_at)
         VALUES ($1,$2,$3,'ORGANIZER',$4,$5,clock_timestamp()+interval '1 hour')`,
        [
          credentialId,
          createHash("sha256").update(token).digest("hex"),
          principalId,
          streamId,
          eventId,
        ],
      );

      const identity = await new OperationsAccessService(pool).authenticate(`Bearer ${token}`);
      const statement = await new OperationsReportingService(pool).statement(identity, vendorId, {
        limit: 10,
      });
      expect(statement.totals).toMatchObject({
        grossUnits: "100",
        verifiedVendorNetUnits: "95",
        availableAllocationUnits: "95",
        allocationStatus: "COMPLETE",
      });

      const incidents = new IncidentService(pool);
      const opened = await incidents.open(identity, {
        affectedVendorId: vendorId,
        affectedTerminalId: null,
        severity: "HIGH",
        summary: "Settlement evidence needs review",
        mitigation: "Pause fulfillment for the affected order.",
        nextAction: "Compare the finalized receipt and POS order.",
        evidenceRefs: [transitionId],
        owner: "operations:lead",
        idempotencyKey: "incident-postgres-0001",
      });
      const replay = await incidents.open(identity, {
        affectedVendorId: vendorId,
        affectedTerminalId: null,
        severity: "HIGH",
        summary: "Settlement evidence needs review",
        mitigation: "Pause fulfillment for the affected order.",
        nextAction: "Compare the finalized receipt and POS order.",
        evidenceRefs: [transitionId],
        owner: "operations:lead",
        idempotencyKey: "incident-postgres-0001",
      });
      expect(replay.incidentId).toBe(opened.incidentId);
      const resolved = await incidents.resolve(identity, String(opened.incidentId), {
        resolutionProof: transitionId,
        idempotencyKey: "resolution-postgres-0001",
      });
      expect(resolved.status).toBe("RESOLVED");
    } finally {
      await pool.query("DELETE FROM operational_incident_actions WHERE actor_id=$1", [principalId]);
      await pool.query("DELETE FROM operational_incidents WHERE opened_by=$1", [principalId]);
      await pool.query("DELETE FROM operations_access_credentials WHERE credential_id=$1", [
        credentialId,
      ]);
      await pool.query("DELETE FROM operations_vendor_beneficiaries WHERE stream_id=$1", [
        streamId,
      ]);
      await pool.query("DELETE FROM payment_projections WHERE stream_id=$1", [streamId]);
      await pool.query("DELETE FROM finalized_chain_logs WHERE stream_id=$1", [streamId]);
      await pool.query("DELETE FROM indexer_cursors WHERE stream_id=$1", [streamId]);
      await pool.end();
    }
  },
  15_000,
);

postgresIt("keeps cashier checkout issuance exact, scoped, and idempotent", async () => {
  if (!databaseUrl) throw new Error("Missing isolated operations test database");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const terminal = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const eventId = hex("a");
  const vendorId = hex("b");
  const streamId = `test:10143:${randomUUID()}`;
  const identity = {
    credentialId: randomUUID(),
    principalId: `vendor:${randomUUID()}`,
    role: "VENDOR" as const,
    streamId,
    eventId,
    vendorId,
  };
  const manifest: CheckoutManifest = {
    schemaVersion: 1,
    chainId: 10_143,
    events: [
      {
        streamId,
        eventId,
        router: address("1"),
        registry: address("2"),
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
        organizerFeeBps: 400,
        platformFeeBps: 100,
        intentLifetimeSeconds: 600,
        vendors: [
          {
            vendorId,
            vendorName: "North Gate Coffee",
            destinationVersion: 1n,
            terminal: { instanceId: hex("c"), keyVersion: 1n, signer: terminal.address },
            reservePolicy: {
              maximumReserveUnits: 50_000_000n,
              maximumPerVoucherUnits: 15_000_000n,
              maximumVoucherCount: 8,
              acceptanceDurationSeconds: 3_600,
              submissionDelaySeconds: 3_600,
            },
          },
        ],
      },
    ],
  };
  const verifier: CheckoutPolicyVerifier = { assert: async () => undefined };
  const now = new Date();
  const service = new CheckoutService(pool, manifest, verifier, Buffer.alloc(32, 7), () => now);
  const orderIds: string[] = [];
  try {
    const request = {
      orderReference: "ORDER-1042",
      orderVersion: 1n,
      description: "Two coffees",
      grossUnits: 12_500_000n,
      idempotencyKey: "checkout-postgres-0001",
    };
    const created = await service.create(identity, request);
    orderIds.push(created.orderId);
    const replay = await service.create(identity, request);
    expect(replay).toMatchObject({
      created: false,
      orderId: created.orderId,
      capability: created.capability,
    });
    await expect(service.create(identity, { ...request, grossUnits: 1n })).rejects.toBeInstanceOf(
      CheckoutConflict,
    );
    const bound = await service.bind(
      { enrollmentId: randomUUID(), account: address("5") },
      created.orderId,
      created.capability,
    );
    if (!("encodedIntent" in bound) || !bound.encodedIntent)
      throw new Error("Checkout did not bind");
    const signature = await terminal.sign({
      hash: paymentIntentDigest(decodePaymentIntent(bound.encodedIntent)),
    });
    const ready = await service.attachSignature(identity, created.orderId, signature);
    const resolved = await service.resolve(created.orderId, `Checkout ${ready.capability}`);
    expect(resolved).toMatchObject({
      orderId: created.orderId,
      terminalSignature: signature.toLowerCase(),
    });
    expect(resolved).not.toHaveProperty("capability");

    const offline = await service.create(identity, {
      ...request,
      orderReference: "ORDER-1043",
      idempotencyKey: "checkout-postgres-0002",
    });
    orderIds.push(offline.orderId);
    await pool.query(
      `INSERT INTO indexer_cursors
       (stream_id,chain_id,deployment_block,block_number,block_hash)
       VALUES ($1,10143,10,10,$2)`,
      [streamId, hex("d")],
    );
    const challenge = await service.beginTerminalProvisioning(identity);
    const provisioningDigest = keccak256(
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
          hex("c"),
          toHex(Buffer.from(challenge.challenge, "base64url"), { size: 32 }),
        ],
      ),
    );
    const provisioningSignature = await terminal.sign({ hash: provisioningDigest });
    const provisioned = await service.terminalProvisioning(
      identity,
      challenge.challenge,
      provisioningSignature,
    );
    expect(provisioned).toMatchObject({
      schemaVersion: 1,
      terminal: { terminalInstanceId: hex("c"), terminalSigner: terminal.address },
      projection: { finalizedBlockNumber: "10", finalizedBlockHash: hex("d") },
      orders: [{ orderId: offline.orderId, state: "OFFLINE_IMPORTED" }],
    });
    await expect(
      service.bind(
        { enrollmentId: randomUUID(), account: address("5") },
        offline.orderId,
        offline.capability,
      ),
    ).rejects.toBeInstanceOf(CheckoutConflict);
    await expect(
      service.terminalProvisioning(identity, challenge.challenge, provisioningSignature),
    ).rejects.toThrow("Terminal proof expired or was replayed");
  } finally {
    if (orderIds.length)
      await pool.query("DELETE FROM checkout_orders WHERE order_id=ANY($1::uuid[])", [orderIds]);
    await pool.query("DELETE FROM indexer_cursors WHERE stream_id=$1", [streamId]);
    await pool.query("DELETE FROM terminal_provisioning_challenges WHERE stream_id=$1", [streamId]);
    await pool.end();
  }
});

postgresIt("keeps organizer configuration preparation and finality exact", async () => {
  if (!databaseUrl) throw new Error("Missing isolated operations test database");
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const eventId = hex("d");
  const streamId = `test:10143:${randomUUID()}`;
  const organizer = address("e");
  const transactionHash = hex("f");
  const identity = {
    credentialId: randomUUID(),
    principalId: `organizer:${randomUUID()}`,
    role: "ORGANIZER" as const,
    streamId,
    eventId,
    vendorId: null,
  };
  const manifest: CheckoutManifest = {
    schemaVersion: 1,
    chainId: 10_143,
    events: [
      {
        streamId,
        eventId,
        router: address("1"),
        registry: address("2"),
        ledger: address("8"),
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
        organizerFeeBps: 400,
        platformFeeBps: 100,
        intentLifetimeSeconds: 600,
        vendors: [
          {
            vendorId: hex("5"),
            vendorName: "North Gate Coffee",
            destinationVersion: 1n,
            terminal: { instanceId: hex("6"), keyVersion: 1n, signer: address("7") },
            reservePolicy: {
              maximumReserveUnits: 50_000_000n,
              maximumPerVoucherUnits: 15_000_000n,
              maximumVoucherCount: 8,
              acceptanceDurationSeconds: 3_600,
              submissionDelaySeconds: 3_600,
            },
          },
        ],
      },
    ],
  };
  let finalized = false;
  let preparedCommand: PreparedOrganizerCommand | undefined;
  const chain: OrganizerConfigurationChain = {
    prepare: async (_event, command) => {
      preparedCommand = command;
      return { organizer, blockNumber: 100n, blockHash: hex("8") };
    },
    confirm: async (_event, command, expectedOrganizer, hash) => {
      expect(command).toMatchObject({
        kind: preparedCommand?.kind,
        aggregateId: preparedCommand?.aggregateId,
        calldata: preparedCommand?.calldata,
      });
      expect(expectedOrganizer).toBe(getAddress(organizer));
      expect(hash).toBe(transactionHash);
      return finalized ? { blockNumber: 110n, blockHash: hex("9") } : null;
    },
  };
  const service = new OrganizerConfigurationService(pool, manifest, chain);
  let operationId: string | undefined;
  try {
    const request = { kind: "VENDOR" as const, vendorId: hex("a"), authority: address("b") };
    const created = await service.prepare(identity, eventId, request, "organizer-command-0001");
    operationId = created.operationId;
    expect(created).toMatchObject({
      created: true,
      state: "PREPARED",
      transaction: { from: getAddress(organizer) },
    });
    expect(
      await service.prepare(identity, eventId, request, "organizer-command-0001"),
    ).toMatchObject({ created: false, operationId });
    await expect(
      service.prepare(
        identity,
        eventId,
        { ...request, authority: address("c") },
        "organizer-command-0001",
      ),
    ).rejects.toBeInstanceOf(OrganizerConfigurationConflict);
    expect(await service.confirm(identity, eventId, operationId, transactionHash)).toMatchObject({
      state: "PREPARED",
      confirmation: "PENDING",
    });
    finalized = true;
    expect(await service.confirm(identity, eventId, operationId, transactionHash)).toMatchObject({
      state: "FINALIZED",
      transactionHash,
      finalizedBlock: "110",
    });
  } finally {
    if (operationId)
      await pool.query("DELETE FROM organizer_configuration_operations WHERE operation_id=$1", [
        operationId,
      ]);
    await pool.end();
  }
});
