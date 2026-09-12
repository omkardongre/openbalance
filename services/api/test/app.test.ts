import { afterEach, describe, expect, it } from "vitest";

import { AccountAccessRejected, type AccountAccessService } from "../src/account-access.js";
import { buildApp } from "../src/app.js";
import type { EnrollmentService } from "../src/enrollment.js";
import { ProjectionNotFound, type OperationalReadService } from "../src/operations.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("health endpoint", () => {
  it("reports the API as available", async () => {
    const app = await buildApp();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "openbalance-api", status: "ok" });
  });
});

describe("authenticated projection reads", () => {
  const account = `0x${"11".repeat(20)}` as const;
  const paymentId = `0x${"22".repeat(32)}` as const;
  const channelId = `0x${"33".repeat(32)}` as const;
  const enrollment = {} as EnrollmentService;

  it("serves only the authenticated account's finalized operational views", async () => {
    const calls: string[] = [];
    const access = {
      authenticate: async (authorization: string | undefined) => {
        expect(authorization).toBe("Bearer token");
        return { enrollmentId: "enrollment", account };
      },
    } as unknown as AccountAccessService;
    const operations = {
      payment: async (owner: string, id: string) => {
        expect(owner).toBe(account);
        expect(id).toBe(paymentId);
        calls.push("payment");
        return { paymentId: id, status: "FINALIZED" };
      },
      channel: async (owner: string, id: string) => {
        expect(owner).toBe(account);
        expect(id).toBe(channelId);
        calls.push("channel");
        return { channelId: id, status: "ACTIVE" };
      },
      activity: async (owner: string, limit: number, cursor: unknown) => {
        expect(owner).toBe(account);
        expect(limit).toBe(10);
        expect(cursor).toEqual({ blockNumber: 42n, transitionId: "transition" });
        calls.push("activity");
        return { items: [], nextCursor: null };
      },
    } as unknown as OperationalReadService;
    const app = await buildApp(enrollment, "https://app.example", undefined, access, operations);
    openApps.push(app);

    const headers = { authorization: "Bearer token" };
    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/v1/payment-intents/${paymentId}`, headers }),
      app.inject({ method: "GET", url: `/v1/reserve-channels/${channelId}`, headers }),
      app.inject({
        method: "GET",
        url: "/v1/accounts/me/activity?limit=10&beforeBlock=42&beforeTransitionId=transition",
        headers,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(calls.sort()).toEqual(["activity", "channel", "payment"]);
    expect(responses.every((response) => response.headers["cache-control"] === "private, no-store"))
      .toBe(true);
  });

  it("returns bounded errors without disclosing another account's projection", async () => {
    const rejectedAccess = {
      authenticate: async () => {
        throw new AccountAccessRejected();
      },
    } as unknown as AccountAccessService;
    const hiddenOperations = {
      payment: async () => {
        throw new ProjectionNotFound();
      },
    } as unknown as OperationalReadService;
    const unauthorized = await buildApp(
      enrollment,
      "https://app.example",
      undefined,
      rejectedAccess,
      hiddenOperations,
    );
    openApps.push(unauthorized);

    const response = await unauthorized.inject({
      method: "GET",
      url: `/v1/payment-intents/${paymentId}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "session_invalid", retryable: false });
  });
});
