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

it("tolerates platform variables but rejects a misspelled ingress setting", () => {
  const complete = {
    VENUE_RELAY_DATABASE_PATH: "/var/lib/openbalance/relay.sqlite",
    VENUE_RELAY_KEY_PATH: "/run/secrets/venue-relay-key",
    TERMINAL_SNAPSHOT_PATH: "/var/lib/openbalance/terminal-snapshot.json",
    TERMINAL_INGRESS_AUDIENCE: "https://relay.example/v1/vouchers",
  };
  expect(() =>
    loadVenueRelayEnvironment({
      ...complete,
      NODE_ENV: "production",
      K_SERVICE: "venue-relay",
      PATH: "/usr/local/bin",
    }),
  ).not.toThrow();
  // Misspelled, so the real skew limit would stay at its default rather than take this value.
  expect(() =>
    loadVenueRelayEnvironment({ ...complete, TERMINAL_MAXIMUM_CLOCK_SKEW_SECOND: "5" }),
  ).toThrow(/TERMINAL_MAXIMUM_CLOCK_SKEW_SECOND/);
});

it("accepts a TLS certificate and key only as a pair", () => {
  const complete = {
    VENUE_RELAY_DATABASE_PATH: "/var/lib/openbalance/relay.sqlite",
    VENUE_RELAY_KEY_PATH: "/run/secrets/venue-relay-key",
    TERMINAL_SNAPSHOT_PATH: "/var/lib/openbalance/terminal-snapshot.json",
    TERMINAL_INGRESS_AUDIENCE: "https://relay.example/v1/vouchers",
  };
  expect(
    loadVenueRelayEnvironment({
      ...complete,
      VENUE_RELAY_TLS_CERT_PATH: "/run/secrets/relay.pem",
      VENUE_RELAY_TLS_KEY_PATH: "/run/secrets/relay.key.pem",
    }).VENUE_RELAY_TLS_CERT_PATH,
  ).toBe("/run/secrets/relay.pem");
  expect(() =>
    loadVenueRelayEnvironment({ ...complete, VENUE_RELAY_TLS_CERT_PATH: "/run/secrets/relay.pem" }),
  ).toThrow(/set together/);
});
