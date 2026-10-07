import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { EnrollmentService } from "../src/enrollment.js";
import { IncidentRejected, IncidentService } from "../src/incidents.js";
import type { OperationsAccessService, OperationsIdentity } from "../src/operations-access.js";
import { OperationsReportingService } from "../src/operations-reporting.js";

const eventId = `0x${"11".repeat(32)}` as const;
const vendorId = `0x${"22".repeat(32)}` as const;
const identity: OperationsIdentity = {
  credentialId: "00000000-0000-4000-8000-000000000001",
  principalId: "vendor:alpha",
  role: "VENDOR",
  streamId: `test:10143:${eventId}`,
  eventId,
  vendorId,
};

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(openApps.splice(0).map((app) => app.close())));

describe("operational control plane", () => {
  it("builds an exact finalized vendor statement and exposes it only through scoped access", async () => {
    const client = {
      query: async (text: string) => {
        if (text.startsWith("SELECT c.block_number"))
          return {
            rowCount: 1,
            rows: [
              {
                block_number: "100",
                block_hash: `0x${"33".repeat(32)}`,
                updated_at: new Date("2026-09-12T00:00:00Z"),
              },
            ],
          };
        if (text.startsWith("WITH refund_totals"))
          return {
            rows: [
              {
                payment_count: 1,
                gross_units: "100",
                refunded_units: "30",
                vendor_credit_refund_units: "20",
                organizer_fee_units: "4",
                platform_fee_units: "1",
                verified_vendor_net_units: "95",
                readback_required_gross_units: "0",
              },
            ],
          };
        if (text.startsWith("SELECT p.payment_id"))
          return {
            rows: [
              {
                payment_id: `0x${"44".repeat(32)}`,
                mode: "ONLINE",
                gross_units: "100",
                organizer_fee_units: "4",
                platform_fee_units: "1",
                allocation_status: "EVENT_VERIFIED",
                transaction_hash: `0x${"55".repeat(32)}`,
                block_number: "90",
                block_hash: `0x${"66".repeat(32)}`,
                refunded_units: "30",
                vendor_credit_refund_units: "20",
              },
            ],
          };
        if (text.startsWith("SELECT beneficiary_id"))
          return {
            rows: [
              {
                beneficiary_id: `0x${"77".repeat(32)}`,
                destination: `0x${"88".repeat(20)}`,
                approved_reference: "destination:v1",
                valid_from_block: "0",
                valid_to_block: null,
              },
            ],
          };
        if (text.startsWith("SELECT w.transition_id"))
          return {
            rows: [
              {
                transition_id: "withdrawal:1",
                beneficiary_id: `0x${"77".repeat(32)}`,
                destination: `0x${"88".repeat(20)}`,
                amount_units: "10",
                transaction_hash: `0x${"99".repeat(32)}`,
                block_number: "95",
                block_hash: `0x${"aa".repeat(32)}`,
              },
            ],
          };
        if (text.startsWith("SELECT COALESCE(SUM(amount_units)"))
          return { rows: [{ amount_units: "10", withdrawal_count: 1 }] };
        return { rowCount: null, rows: [] };
      },
      release: () => undefined,
    };
    const reporting = new OperationsReportingService({
      connect: async () => client,
    } as unknown as Pool);
    const access = {
      authenticate: async () => identity,
      assertRole: () => undefined,
      assertEvent: () => undefined,
      assertVendor: () => undefined,
    } as unknown as OperationsAccessService;
    const incidents = {} as IncidentService;
    const app = await buildApp(
      {} as EnrollmentService,
      "https://app.example",
      undefined,
      undefined,
      undefined,
      { access, reporting, incidents },
    );
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/v1/events/${eventId}/statements?vendorId=${vendorId}`,
      headers: { authorization: "Bearer scoped-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({
      grossUnits: "100",
      refundedUnits: "30",
      verifiedVendorNetUnits: "95",
      withdrawnUnits: "10",
      availableAllocationUnits: "65",
      allocationStatus: "COMPLETE",
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("splits every reserved unit into settled, returned, open and due-to-return", async () => {
    const summary = (row: Record<string, unknown>) =>
      new OperationsReportingService({
        connect: async () => ({
          query: async (text: string) => {
            if (text.startsWith("SELECT c.block_number"))
              return {
                rowCount: 1,
                rows: [
                  {
                    block_number: "100",
                    block_hash: `0x${"33".repeat(32)}`,
                    updated_at: new Date("2026-10-07T00:00:00Z"),
                  },
                ],
              };
            if (text.startsWith("WITH scoped")) return { rows: [row] };
            return { rowCount: null, rows: [] };
          },
          release: () => undefined,
        }),
      } as unknown as Pool).reserves({ ...identity, role: "ORGANIZER", vendorId: null });
    const totals = {
      reserve_count: 3,
      reserved_units: "30000000",
      settled_units: "9000000",
      returned_units: "6000000",
      open_count: 1,
      open_units: "10000000",
      returnable_count: 1,
      returnable_units: "5000000",
      next_deadline: "1791300000",
      as_of: "1791296961",
    };

    await expect(summary(totals)).resolves.toMatchObject({
      reserveCount: 3,
      reservedUnits: "30000000",
      settledOfflineUnits: "9000000",
      returnedUnits: "6000000",
      open: { count: 1, units: "10000000" },
      returnable: { count: 1, units: "5000000" },
      nextDeadline: "1791300000",
    });
    await expect(summary({ ...totals, returnable_units: "4000000" })).rejects.toThrow(
      "Reserve projection does not conserve reserved value",
    );
  });

  it("prevents a vendor from opening an incident against another vendor", async () => {
    const incidents = new IncidentService({} as Pool);
    await expect(
      incidents.open(identity, {
        affectedVendorId: `0x${"ff".repeat(32)}`,
        affectedTerminalId: null,
        severity: "HIGH",
        summary: "Terminal receipt mismatch",
        mitigation: "Stop offline acceptance.",
        nextAction: "Reconcile the signed receipt.",
        evidenceRefs: ["receipt:one"],
        owner: "vendor:alpha",
        idempotencyKey: "incident-request-0001",
      }),
    ).rejects.toBeInstanceOf(IncidentRejected);
  });
});
