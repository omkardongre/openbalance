import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { IncidentService } from "../src/incidents.js";
import { OperationsAccessService } from "../src/operations-access.js";
import { OperationsReportingService } from "../src/operations-reporting.js";

const databaseUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
const eligible = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && url.pathname.includes("test");
})();
const postgresIt = eligible ? it : it.skip;
const hex = (digit: string) => `0x${digit.repeat(64)}` as const;

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
