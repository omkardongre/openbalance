import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Hex } from "viem";
import type { OperationsIdentity } from "./operations-access.js";

export type IncidentSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type OpenIncident = {
  affectedVendorId: Hex | null;
  affectedTerminalId: Hex | null;
  severity: IncidentSeverity;
  summary: string;
  mitigation: string;
  nextAction: string;
  evidenceRefs: readonly string[];
  owner: string;
  idempotencyKey: string;
};

export class IncidentConflict extends Error {}
export class IncidentNotFound extends Error {}
export class IncidentRejected extends Error {}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const idempotency = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

function boundedText(value: string, maximum: number) {
  return (
    value.length >= 1 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function hash(value: unknown): Hex {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function normalize(input: OpenIncident) {
  const evidenceRefs = [...new Set(input.evidenceRefs)];
  if (
    !identifier.test(input.owner) ||
    !idempotency.test(input.idempotencyKey) ||
    input.summary.length < 5 ||
    input.summary.length > 500 ||
    input.mitigation.length < 1 ||
    input.mitigation.length > 2_000 ||
    input.nextAction.length < 1 ||
    input.nextAction.length > 1_000 ||
    evidenceRefs.length > 20 ||
    evidenceRefs.some((item) => !boundedText(item, 500))
  )
    throw new IncidentRejected();
  return { ...input, evidenceRefs };
}

function response(row: Record<string, unknown>) {
  return {
    incidentId: row.incident_id,
    eventId: row.event_id,
    affectedVendorId: row.affected_vendor_id ?? null,
    affectedTerminalId: row.affected_terminal_id ?? null,
    severity: row.severity,
    summary: row.summary,
    mitigation: row.mitigation,
    nextAction: row.next_action,
    evidenceRefs: row.evidence_refs,
    owner: row.owner,
    status: row.status,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string | Date).toISOString() : null,
    resolutionProof: row.resolution_proof ?? null,
  };
}

const incidentColumns = `incident_id,event_id,affected_vendor_id,affected_terminal_id,severity,
  summary,mitigation,next_action,evidence_refs,owner,status,created_at,resolved_at,resolution_proof`;

export class IncidentService {
  constructor(private readonly pool: Pool) {}

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      "SELECT to_regclass('public.operational_incidents') AS incidents",
    );
    if (!result.rows[0]?.incidents)
      throw new Error("Operational incident migration is not installed");
  }

  async open(identity: OperationsIdentity, candidate: OpenIncident) {
    const input = normalize(candidate);
    if (
      identity.role === "VENDOR" &&
      (input.affectedVendorId === null ||
        input.affectedVendorId.toLowerCase() !== identity.vendorId?.toLowerCase())
    )
      throw new IncidentRejected();
    const requestHash = hash({
      streamId: identity.streamId,
      eventId: identity.eventId.toLowerCase(),
      affectedVendorId: input.affectedVendorId?.toLowerCase() ?? null,
      affectedTerminalId: input.affectedTerminalId?.toLowerCase() ?? null,
      severity: input.severity,
      summary: input.summary,
      mitigation: input.mitigation,
      nextAction: input.nextAction,
      evidenceRefs: input.evidenceRefs,
      owner: input.owner,
    });
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const existing = await db.query(
        `SELECT ${incidentColumns},request_hash FROM operational_incidents
         WHERE opened_by=$1 AND idempotency_key=$2 FOR UPDATE`,
        [identity.principalId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new IncidentConflict();
        await db.query("COMMIT");
        return response(existing.rows[0]);
      }
      const incidentId = randomUUID();
      const inserted = await db.query(
        `INSERT INTO operational_incidents
          (incident_id,stream_id,event_id,affected_vendor_id,affected_terminal_id,severity,
           summary,mitigation,next_action,evidence_refs,owner,opened_by,opened_by_role,
           idempotency_key,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
         RETURNING ${incidentColumns}`,
        [
          incidentId,
          identity.streamId,
          identity.eventId.toLowerCase(),
          input.affectedVendorId?.toLowerCase() ?? null,
          input.affectedTerminalId?.toLowerCase() ?? null,
          input.severity,
          input.summary,
          input.mitigation,
          input.nextAction,
          JSON.stringify(input.evidenceRefs),
          input.owner,
          identity.principalId,
          identity.role,
          input.idempotencyKey,
          requestHash,
        ],
      );
      await db.query(
        `INSERT INTO operational_incident_actions
          (action_id,incident_id,action_kind,actor_id,actor_role,evidence)
         VALUES ($1,$2,'OPENED',$3,$4,$5::jsonb)`,
        [
          randomUUID(),
          incidentId,
          identity.principalId,
          identity.role,
          JSON.stringify({ requestHash }),
        ],
      );
      await db.query("COMMIT");
      return response(inserted.rows[0]);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async list(identity: OperationsIdentity, status: "OPEN" | "RESOLVED", limit: number) {
    const result = await this.pool.query(
      `SELECT ${incidentColumns} FROM operational_incidents
       WHERE stream_id=$1 AND event_id=$2 AND status=$3
         AND ($4::text IS NULL OR affected_vendor_id=$4)
       ORDER BY created_at DESC,incident_id DESC LIMIT $5`,
      [
        identity.streamId,
        identity.eventId.toLowerCase(),
        status,
        identity.role === "VENDOR" ? identity.vendorId?.toLowerCase() : null,
        limit,
      ],
    );
    return { items: result.rows.map(response) };
  }

  async resolve(
    identity: OperationsIdentity,
    incidentId: string,
    input: { resolutionProof: string; idempotencyKey: string },
  ) {
    if (
      !["ORGANIZER", "SUPPORT"].includes(identity.role) ||
      !idempotency.test(input.idempotencyKey) ||
      !boundedText(input.resolutionProof, 2_000)
    )
      throw new IncidentRejected();
    const resolutionHash = hash({ incidentId, resolutionProof: input.resolutionProof });
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const current = await db.query(
        `SELECT ${incidentColumns},stream_id,resolution_hash,resolution_idempotency_key,resolved_by
         FROM operational_incidents WHERE incident_id=$1 FOR UPDATE`,
        [incidentId],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.stream_id !== identity.streamId ||
        String(row.event_id).toLowerCase() !== identity.eventId.toLowerCase()
      )
        throw new IncidentNotFound();
      if (row.status === "RESOLVED") {
        if (
          row.resolved_by !== identity.principalId ||
          row.resolution_idempotency_key !== input.idempotencyKey ||
          row.resolution_hash !== resolutionHash
        )
          throw new IncidentConflict();
        await db.query("COMMIT");
        return response(row);
      }
      const updated = await db.query(
        `UPDATE operational_incidents SET status='RESOLVED',resolved_at=clock_timestamp(),
           resolution_proof=$2,resolved_by=$3,resolution_idempotency_key=$4,resolution_hash=$5
         WHERE incident_id=$1 AND status='OPEN' RETURNING ${incidentColumns}`,
        [
          incidentId,
          input.resolutionProof,
          identity.principalId,
          input.idempotencyKey,
          resolutionHash,
        ],
      );
      if (updated.rowCount !== 1) throw new IncidentConflict();
      await db.query(
        `INSERT INTO operational_incident_actions
          (action_id,incident_id,action_kind,actor_id,actor_role,evidence)
         VALUES ($1,$2,'RESOLVED',$3,$4,$5::jsonb)`,
        [
          randomUUID(),
          incidentId,
          identity.principalId,
          identity.role,
          JSON.stringify({ resolutionHash, proof: input.resolutionProof }),
        ],
      );
      await db.query("COMMIT");
      return response(updated.rows[0]);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
}
