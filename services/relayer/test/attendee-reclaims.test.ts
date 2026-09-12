import type { Pool } from "pg";
import { keccak256, stringToHex } from "viem";
import { expect, it, vi } from "vitest";
import { type AttendeeReclaimRejected, AttendeeReclaimService } from "../src/attendee-reclaims.js";
import type { AcceptFinancialOperation, FinancialOperation } from "../src/financial-operations.js";

const eventId = keccak256(stringToHex("reclaim-event"));
const channelId = keccak256(stringToHex("reclaim-channel"));
const account = "0x0000000000000000000000000000000000000202";
const vault = "0x0000000000000000000000000000000000000606";

function build(submitUntil: string) {
  const query = vi.fn(async () => ({
    rows: [{ submit_until: submitUntil, reclaimed: false }],
    rowCount: 1,
  }));
  const accept = vi.fn(async (input: AcceptFinancialOperation) => ({
    created: true,
    operation: {
      ...input,
      operationId: "00000000-0000-4000-8000-000000000002",
      state: "ACCEPTED",
    } as FinancialOperation,
  }));
  return {
    accept,
    service: new AttendeeReclaimService({
      pool: { query } as unknown as Pool,
      journal: { accept },
      manifest: {
        schemaVersion: 1,
        chainId: 10_143,
        events: [
          {
            eventId,
            router: "0x0000000000000000000000000000000000000101",
            vault,
            ledger: "0x0000000000000000000000000000000000000707",
            asset: "0x0000000000000000000000000000000000000303",
            deploymentBlock: 1n,
          },
        ],
      },
      now: () => new Date(1_800_000_000_000),
    }),
  };
}

it("enforces the finalized owner and deadline before creating a fixed-destination reclaim", async () => {
  const blocked = build("1800000001");
  await expect(
    blocked.service.accept({
      identity: { enrollmentId: "enrollment", account },
      eventId,
      channelId,
      idempotencyKey: "reclaim:channel:0001",
    }),
  ).rejects.toMatchObject<Partial<AttendeeReclaimRejected>>({ code: "reclaim_not_yet_eligible" });

  const ready = build("1800000000");
  await expect(
    ready.service.accept({
      identity: { enrollmentId: "enrollment", account },
      eventId,
      channelId,
      idempotencyKey: "reclaim:channel:0001",
    }),
  ).resolves.toMatchObject({ kind: "RESERVE_RECLAIM", aggregateId: channelId });
  expect(ready.accept).toHaveBeenCalledWith(
    expect.objectContaining({ targetAddress: vault, actorId: `attendee:${account}` }),
  );
});
