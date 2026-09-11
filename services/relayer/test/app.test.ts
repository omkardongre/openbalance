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
