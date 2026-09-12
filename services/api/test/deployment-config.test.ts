import { expect, it } from "vitest";
import { loadEnvironment } from "../src/config.js";
import { accountManifestSchema } from "../src/deployment-chain.js";

it("requires complete deployment configuration and limits manifests to supported test networks", () => {
  expect(() => loadEnvironment({ ACCOUNT_RPC_URL: "https://example.invalid" })).toThrow();
  expect(() =>
    loadEnvironment({
      ACCOUNT_RPC_URL: "https://example.invalid",
      ACCOUNT_MANIFEST_PATH: "manifest.json",
    }),
  ).toThrow();
  expect(() => accountManifestSchema.parse({ version: 1, chainId: 143 })).toThrow();
  expect(loadEnvironment({}).ACCOUNT_RPC_URL).toBeUndefined();
  expect(() => loadEnvironment({ PROJECTION_READS_ENABLED: "true" })).toThrow();
  expect(
    loadEnvironment({
      DATABASE_URL: "postgresql://localhost/openbalance",
      WEBAUTHN_RP_ID: "app.example",
      WEBAUTHN_ORIGIN: "https://app.example",
      PROJECTION_READS_ENABLED: "true",
    }).PROJECTION_READS_ENABLED,
  ).toBe(true);
});
