import { expect, it } from "vitest";
import { loadVenueRelayEnvironment } from "../src/config.js";

it("requires explicit storage, key, snapshot, and ingress audience configuration", () => {
  expect(() => loadVenueRelayEnvironment({})).toThrow();
  expect(() =>
    loadVenueRelayEnvironment({
      VENUE_RELAY_DATABASE_PATH: "/var/lib/openbalance/relay.sqlite",
      VENUE_RELAY_KEY_PATH: "/run/secrets/venue-relay-key",
      TERMINAL_SNAPSHOT_PATH: "/var/lib/openbalance/terminal-snapshot.json",
      TERMINAL_INGRESS_AUDIENCE: "https://relay.example/v1/vouchers",
    }),
  ).not.toThrow();
});
