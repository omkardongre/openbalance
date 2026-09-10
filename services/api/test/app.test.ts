import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

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
