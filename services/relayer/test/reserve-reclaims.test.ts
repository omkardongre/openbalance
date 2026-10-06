import type { DeploymentSponsorshipService } from "@openbalance/api/sponsorship";
import type { Pool } from "pg";
import { keccak256, stringToHex } from "viem";
import { afterEach, expect, it, vi } from "vitest";
import { buildRelayerApp } from "../src/app.js";
import type { AcceptFinancialOperation, FinancialOperation } from "../src/financial-operations.js";
import {
  RESERVE_RETURN_ACTOR,
  type ReserveReclaimRejected,
  ReserveReclaimService,
} from "../src/reserve-reclaims.js";

const eventId = keccak256(stringToHex("reclaim-event"));
const channelId = keccak256(stringToHex("reclaim-channel"));
const vault = "0x0000000000000000000000000000000000000606";
const origin = "http://localhost:3000";
const openApps: Awaited<ReturnType<typeof buildRelayerApp>>[] = [];
afterEach(async () => Promise.all(openApps.splice(0).map((app) => app.close())));

function build(input: { submitUntil: string; history: FinancialOperation["state"][] }) {
  const query = vi.fn(async () => ({
    rows: [{ submit_until: input.submitUntil, reclaimed: false }],
    rowCount: 1,
  }));
  const states = [...input.history];
  const aggregateHistory = vi.fn(async () => {
    const state = states.at(-1);
    return {
      latest: state
        ? ({
            operationId: "00000000-0000-4000-8000-000000000001",
            kind: "RESERVE_RECLAIM",
            aggregateId: channelId,
            state,
            transaction: null,
            finalizedBlockNumber: null,
            failureCode: null,
          } as unknown as FinancialOperation)
        : null,
      failed: states.filter((value) => value === "FAILED").length,
    };
  });
  const accept = vi.fn(async (operation: AcceptFinancialOperation) => ({
    created: true,
    operation: {
      ...operation,
      operationId: "00000000-0000-4000-8000-000000000002",
      state: "ACCEPTED",
      transaction: null,
      finalizedBlockNumber: null,
      failureCode: null,
    } as unknown as FinancialOperation,
  }));
  const service = new ReserveReclaimService({
    pool: { query } as unknown as Pool,
    journal: { accept, aggregateHistory },
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
    chainSeconds: async () => 1_800_000_000n,
    now: () => new Date(1_800_000_000_000),
  });
  return { accept, service };
}

it("keeps one live return per channel and opens a new attempt only after a failed one", async () => {
  const early = build({ submitUntil: "1800000001", history: [] });
  await expect(early.service.accept({ eventId, channelId })).rejects.toMatchObject<
    Partial<ReserveReclaimRejected>
  >({ code: "reclaim_not_yet_eligible" });

  const live = build({ submitUntil: "1800000000", history: ["SUBMITTED"] });
  await expect(live.service.accept({ eventId, channelId })).resolves.toMatchObject({
    created: false,
    state: "SUBMITTED",
  });
  expect(live.accept).not.toHaveBeenCalled();

  const retried = build({ submitUntil: "1800000000", history: ["FAILED"] });
  await expect(retried.service.accept({ eventId, channelId })).resolves.toMatchObject({
    created: true,
    kind: "RESERVE_RECLAIM",
  });
  expect(retried.accept).toHaveBeenCalledWith(
    expect.objectContaining({
      actorId: RESERVE_RETURN_ACTOR,
      idempotencyKey: `reclaim:${channelId}:1`,
      targetAddress: vault,
    }),
  );
});

it("accepts a return from any caller without a session or browser origin", async () => {
  const { service } = build({ submitUntil: "1800000000", history: [] });
  const app = await buildRelayerApp({} as DeploymentSponsorshipService, origin, {
    access: {} as never,
    commands: {} as never,
    reclaims: service,
  });
  openApps.push(app);
  const response = await app.inject({
    method: "POST",
    url: `/v1/reserve-channels/${channelId}/reclaims`,
    payload: { eventId },
  });
  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    statusUrl: `/v1/reserve-channels/${channelId}/reclaims`,
  });
});
