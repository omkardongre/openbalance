import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { OperationalReadService } from "../src/operations.js";

describe("operational projection service", () => {
  it("derives a partial-refund status from one consistent finalized snapshot", async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.startsWith("SELECT p.stream_id"))
          return {
            rowCount: 1,
            rows: [
              {
                payment_id: `0x${"22".repeat(32)}`,
                mode: "ONLINE",
                vendor_id: `0x${"33".repeat(32)}`,
                channel_id: null,
                gross_units: "100",
                organizer_fee_units: "4",
                platform_fee_units: "1",
                allocation_status: "EVENT_VERIFIED",
                transaction_hash: `0x${"44".repeat(32)}`,
                block_number: "80",
                transaction_block_hash: `0x${"66".repeat(32)}`,
                finalized_block: "96",
                finalized_block_hash: `0x${"55".repeat(32)}`,
                refunded_units: "30",
                refund_count: 1,
              },
            ],
          };
        return { rowCount: null, rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const service = new OperationalReadService(pool);

    const result = await service.payment(`0x${"11".repeat(20)}`, `0x${"22".repeat(32)}`);

    expect(result.status).toBe("PARTIALLY_REFUNDED");
    expect(result.refundedUnits).toBe("30");
    expect(result.proof.finalizedThroughBlock).toBe("96");
    expect(queries[1]?.values).toEqual([`0x${"22".repeat(32)}`, `0x${"11".repeat(20)}`]);
    expect(queries.map(({ text }) => text)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      expect.stringContaining("WHERE p.payment_id=$1 AND p.payer=$2"),
      "COMMIT",
    ]);
  });
});
