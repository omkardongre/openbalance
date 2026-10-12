// Run: node --test apps/web/test/terminal-setup.test.mts (Node 24 strips the types natively).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTerminalSetupPayload, voucherIngressUrl } from "../src/lib/terminal-setup.ts";

const relayer = "https://openbalance-testnet-relayer-607263679674.us-central1.run.app";
const token = "A".repeat(43);

function decode(code: string) {
  assert.ok(code.startsWith("obterm2:"));
  return Buffer.from(code.slice("obterm2:".length), "base64url").toString();
}

test("the voucher path appears once, whatever form the relayer URL takes", () => {
  const ingress = `${relayer}/v1/vouchers`;
  for (const value of [relayer, `${relayer}/`, ingress, `${ingress}/`]) {
    assert.equal(voucherIngressUrl(value), ingress, value);
  }
});

test("a non-HTTPS relayer is refused, as the terminal would refuse it", () => {
  assert.throws(() => voucherIngressUrl("http://localhost:3003"));
});

test("the payload matches Android's JSONObject.toString() byte for byte", () => {
  const payload = decode(
    buildTerminalSetupPayload(
      {
        api: "https://api.example/",
        rpc: "https://testnet-rpc.monad.xyz",
        relay: `${relayer}/v1/vouchers`,
      },
      token,
    ),
  );
  assert.equal(
    payload,
    `{"schemaVersion":2,"apiEndpoint":"https:\\/\\/api.example","rpcEndpoint":"https:\\/\\/testnet-rpc.monad.xyz",` +
      `"relayEndpoint":"${relayer.replaceAll("/", "\\/")}\\/v1\\/vouchers","accessToken":"${token}"}`,
  );
});
