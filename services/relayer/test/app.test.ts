import type { DeploymentSponsorshipService } from "@openbalance/api/sponsorship";
import { afterEach, expect, it, vi } from "vitest";
import { buildRelayerApp } from "../src/app.js";

const origin = "http://localhost:3000";
const openApps: Awaited<ReturnType<typeof buildRelayerApp>>[] = [];
afterEach(async () => Promise.all(openApps.splice(0).map((app) => app.close())));

it("enforces origin, request shape and idempotency before sponsorship", async () => {
  const process = vi.fn(async () => ({ status: "submitted", transactionHash: "0x01" }));
  const app = await buildRelayerApp({ process } as unknown as DeploymentSponsorshipService, origin);
  openApps.push(app);
  const token = "a".repeat(43);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/accounts/deployments/sponsor",
        headers: { origin: "https://evil.invalid", "idempotency-key": "deployment:123456" },
        payload: { token },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/accounts/deployments/sponsor",
        headers: { origin },
        payload: { token },
      })
    ).statusCode,
  ).toBe(400);
  const accepted = await app.inject({
    method: "POST",
    url: "/v1/accounts/deployments/sponsor",
    headers: { origin, "idempotency-key": "deployment:123456" },
    payload: { token },
  });
  expect(accepted.statusCode).toBe(200);
  expect(process).toHaveBeenCalledOnce();
});

it("rate-limits per client behind the Cloud Run front end without trusting other peers", async () => {
  const app = await buildRelayerApp({} as DeploymentSponsorshipService, origin);
  openApps.push(app);
  const frontEnd = "::ffff:169.254.169.126";
  const remaining = async (remoteAddress: string, forwardedFor: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/v1/accounts/deployments/sponsor",
        remoteAddress,
        headers: { origin, "x-forwarded-for": forwardedFor },
        payload: {},
      })
    ).headers["x-ratelimit-remaining"];

  // Two clients through the front end draw from separate budgets.
  expect(await remaining(frontEnd, "198.51.100.1")).toBe("9");
  expect(await remaining(frontEnd, "198.51.100.1")).toBe("8");
  expect(await remaining(frontEnd, "198.51.100.2")).toBe("9");
  // A spoofed earlier hop does not create a fresh budget: only the front end's entry counts.
  expect(await remaining(frontEnd, "203.0.113.9, 198.51.100.1")).toBe("7");
  // A direct caller cannot pick its key through the header.
  expect(await remaining("203.0.113.50", "198.51.100.3")).toBe("9");
  expect(await remaining("203.0.113.50", "198.51.100.4")).toBe("8");
});

it("accepts terminal ingress without a browser origin and on its own rate budget", async () => {
  const accept = vi.fn(async () => ({
    receiptId: "receipt:1",
    state: "PENDING" as const,
    transactionHash: null,
    duplicate: false,
  }));
  const app = await buildRelayerApp({} as DeploymentSponsorshipService, origin, {
    access: {} as never,
    commands: {} as never,
    terminalVouchers: { accept } as never,
  });
  openApps.push(app);
  const malformed = await app.inject({ method: "POST", url: "/v1/vouchers", payload: {} });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.headers["x-ratelimit-remaining"]).toBe("119");
  const hex = (byte: string) => `0x${byte.repeat(32)}`;
  const uploaded = await app.inject({
    method: "POST",
    url: "/v1/vouchers",
    payload: {
      receipt: {
        receiptId: "receipt:1",
        terminalId: hex("01"),
        channelId: hex("02"),
        sequence: 1,
        paymentId: hex("03"),
        voucher: "0x00",
        attendeeSignature: `0x${"11".repeat(65)}`,
        terminalSignature: `0x${"22".repeat(65)}`,
      },
      authorization: {
        keyVersion: "1",
        sentAt: 1,
        nonce: hex("04"),
        signature: `0x${"33".repeat(65)}`,
      },
    },
  });
  expect(uploaded.statusCode).toBe(201);
  expect(accept).toHaveBeenCalledOnce();
});
