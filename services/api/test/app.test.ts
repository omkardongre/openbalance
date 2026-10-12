import { afterEach, describe, expect, it } from "vitest";

import { AccountAccessRejected, type AccountAccessService } from "../src/account-access.js";
import { buildApp, type OperationsControl } from "../src/app.js";
import type { CheckoutService } from "../src/checkout.js";
import type { EnrollmentService } from "../src/enrollment.js";
import { type OperationalReadService, ProjectionNotFound } from "../src/operations.js";

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
      reserves: async (owner: string, limit: number, cursor: unknown) => {
        expect(owner).toBe(account);
        expect(limit).toBe(5);
        expect(cursor).toEqual({ openedBlock: 7n, channelId });
        calls.push("reserves");
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
      app.inject({
        method: "GET",
        url: `/v1/accounts/me/reserves?limit=5&beforeOpenedBlock=7&beforeChannelId=${channelId}`,
        headers,
      }),
      // Half a cursor is refused rather than silently restarting from the newest page.
      app.inject({ method: "GET", url: "/v1/accounts/me/reserves?beforeOpenedBlock=7", headers }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 400]);
    expect(calls.sort()).toEqual(["activity", "channel", "payment", "reserves"]);
    expect(
      responses
        .slice(0, 4)
        .every((response) => response.headers["cache-control"] === "private, no-store"),
    ).toBe(true);
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
  it("lets a stall phone open and sign an online order without a browser origin", async () => {
    const orderUuid = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const capability = "c".repeat(43);
    const calls: string[] = [];
    const checkout = {
      create: async () => {
        calls.push("create");
        return {
          created: true,
          capability,
          schemaVersion: 1,
          orderId: orderUuid,
          state: "CREATED",
        };
      },
      attachSignature: async () => {
        calls.push("sign");
        return { capability, schemaVersion: 1, orderId: orderUuid, state: "READY" };
      },
    } as unknown as CheckoutService;
    const control = {
      access: {
        authenticate: async () => ({ role: "VENDOR" }),
        assertRole: () => undefined,
      },
      checkout,
    } as unknown as OperationsControl;
    const app = await buildApp(
      enrollment,
      "https://app.example",
      undefined,
      undefined,
      undefined,
      control,
    );
    openApps.push(app);
    const headers = { authorization: "Bearer token", "idempotency-key": "ol-0123456789abcdef" };
    const payload = {
      orderReference: "OL-1",
      orderVersion: "1",
      description: "Custom amount",
      grossUnits: "500000",
    };

    const phone = await app.inject({
      method: "POST",
      url: "/v1/terminal/checkout-orders",
      headers,
      payload,
    });
    expect(phone.statusCode).toBe(201);
    // The customer opens this link on the attendee site; the order and capability stay in the fragment.
    expect(phone.json().checkoutUrl).toBe(
      `https://app.example/checkout#request=${encodeURIComponent(
        JSON.stringify({ schemaVersion: 1, orderId: orderUuid, capability }),
      )}`,
    );
    const signed = await app.inject({
      method: "POST",
      url: `/v1/terminal/checkout-orders/${orderUuid}/terminal-signature`,
      headers: { authorization: "Bearer token" },
      payload: { terminalSignature: `0x${"ab".repeat(65)}` },
    });
    expect(signed.statusCode).toBe(200);
    // The browser route keeps its origin check.
    const browser = await app.inject({
      method: "POST",
      url: "/v1/checkout-orders",
      headers,
      payload,
    });
    expect(browser.statusCode).toBe(403);
    expect(calls).toEqual(["create", "sign"]);
  });
});
