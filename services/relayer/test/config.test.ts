import { expect, it } from "vitest";
import { loadRelayerEnvironment } from "../src/config.js";

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
