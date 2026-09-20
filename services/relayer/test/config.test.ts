import { expect, it } from "vitest";
import { loadRelayerDatabaseConfig, loadRelayerEnvironment } from "../src/config.js";

it("requires an explicit and complete relayer configuration", () => {
  expect(() => loadRelayerEnvironment({})).toThrow();
  expect(() =>
    loadRelayerEnvironment({
      DATABASE_URL: "postgresql://localhost/openbalance",
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGIN: "http://localhost:3000",
      ACCOUNT_MANIFEST_PATH: "/run/openbalance/account-manifest.json",
      ACCOUNT_RPC_URL: "https://rpc.example.invalid",
      SPONSOR_PRIVATE_KEY_PATH: "/run/secrets/sponsor",
      SPONSOR_DAILY_DEPLOYMENTS: "10",
      SPONSOR_MAX_DEPLOYMENT_GAS: "1000000",
      SPONSOR_MAX_FEE_PER_GAS_WEI: "100000000000",
      SPONSOR_MAX_COST_WEI: "100000000000000000",
    }),
  ).not.toThrow();
});

it("tolerates platform variables but rejects a misspelled policy limit", () => {
  const complete = {
    DATABASE_URL: "postgresql://localhost/openbalance",
    WEBAUTHN_RP_ID: "localhost",
    WEBAUTHN_ORIGIN: "http://localhost:3000",
    ACCOUNT_MANIFEST_PATH: "/run/openbalance/account-manifest.json",
    ACCOUNT_RPC_URL: "https://rpc.example.invalid",
    SPONSOR_PRIVATE_KEY_PATH: "/run/secrets/sponsor",
    SPONSOR_DAILY_DEPLOYMENTS: "10",
    SPONSOR_MAX_DEPLOYMENT_GAS: "1000000",
    SPONSOR_MAX_FEE_PER_GAS_WEI: "100000000000",
    SPONSOR_MAX_COST_WEI: "100000000000000000",
  };
  // A managed runtime injects these; rejecting them would fail every start on such a platform.
  expect(() =>
    loadRelayerEnvironment({
      ...complete,
      NODE_ENV: "production",
      K_SERVICE: "relayer",
      K_REVISION: "relayer-00001-abc",
      PATH: "/usr/local/bin",
    }),
  ).not.toThrow();
  // A typo inside our own namespace would leave the real limit at its default, so it must fail.
  expect(() => loadRelayerEnvironment({ ...complete, SPONSOR_MAX_COST_WEI_: "1" })).toThrow(
    /SPONSOR_MAX_COST_WEI_/,
  );
});

it("keeps database migration configuration independent from runtime secrets", () => {
  expect(loadRelayerDatabaseConfig({ DATABASE_URL: "postgresql://localhost/openbalance" })).toEqual(
    { databaseUrl: "postgresql://localhost/openbalance" },
  );
  expect(() => loadRelayerDatabaseConfig({})).toThrow();
});
