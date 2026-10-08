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
