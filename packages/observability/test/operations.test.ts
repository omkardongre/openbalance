import Fastify from "fastify";
import { expect, it } from "vitest";
import { attachHttpOperations } from "../src/index.js";

it("exposes correlation and fails readiness when a dependency is unavailable", async () => {
  const app = Fastify();
  await attachHttpOperations(app, {
    serviceName: "test-service",
    readiness: [
      {
        name: "database",
        check: async () => {
          throw new Error("down");
        },
      },
    ],
  });
  const live = await app.inject({
    method: "GET",
    url: "/health/live",
    headers: { "x-request-id": "payment:test-1" },
  });
  expect(live.statusCode).toBe(200);
  expect(live.headers["x-request-id"]).toBe("payment:test-1");
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  expect(ready.statusCode).toBe(503);
  expect(ready.json()).toEqual({
    status: "not_ready",
    checks: [{ name: "database", status: "failed" }],
  });
  await app.close();
});
