// Run: node --test apps/web/test/friendly-error.test.mts (Node 24 strips the types natively).
import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyError } from "../src/lib/account-display.ts";

test("known failures get a specific plain message", () => {
  assert.equal(
    friendlyError(new Error("faucet_account_limit"), "x"),
    "You have already received the most test money one account can get.",
  );
});

test("technical details never reach the person; plain messages pass through", () => {
  const fallback = "The payment was not approved.";
  assert.equal(friendlyError(new Error("Channel 0xabc nonce mismatch"), fallback), fallback);
  assert.equal(friendlyError(new Error("Financial RPC is not configured."), fallback), fallback);
  assert.equal(friendlyError(new Error("Choose a stall first."), fallback), "Choose a stall first.");
});
