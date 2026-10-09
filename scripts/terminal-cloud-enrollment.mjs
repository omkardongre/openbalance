// Writes a terminal enrollment QR whose receipt upload goes straight to the cloud relayer.
//
// The terminal keeps every offline sale in its own durable journal and uploads it once it is back
// online, signing each upload with its terminal key over this exact endpoint. With the cloud ingress
// the venue relay is optional: it remains the on-site fallback for an event whose internet stays down
// past a reserve's submission deadline, and serves the same contract.
//
// Same API endpoint, RPC endpoint and vendor credential as the current enrollment
// (secrets/testnet/terminal-enrollment-qr.png); only the relay endpoint changes.
//
// Usage: node scripts/terminal-cloud-enrollment.mjs
//   writes secrets/testnet/terminal-cloud-enrollment-qr.png

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const secrets = join(root, "secrets", "testnet");
const RELAY_ENDPOINT =
  process.env.TERMINAL_RELAY_ENDPOINT ??
  "https://openbalance-testnet-relayer-607263679674.us-central1.run.app/v1/vouchers";
if (!/^https:\/\/[^/?#\s]+\/v1\/vouchers$/.test(RELAY_ENDPOINT))
  throw new Error("Relay endpoint must be an HTTPS /v1/vouchers ingress");

const { decodeQrPng } = await import(join(root, "packages", "scenario", "dist", "attendee-signer.js"));
const existing = decodeQrPng(readFileSync(join(secrets, "terminal-enrollment-qr.png")));
const config = JSON.parse(Buffer.from(existing.replace(/^obterm2:/, ""), "base64url").toString());
// The terminal compares the payload byte for byte with Android's `JSONObject.toString()`, which
// escapes every `/` as `\/`; plain JSON.stringify output is rejected as non-canonical.
const canonical = JSON.stringify({
  schemaVersion: 2,
  apiEndpoint: config.apiEndpoint,
  rpcEndpoint: config.rpcEndpoint,
  relayEndpoint: RELAY_ENDPOINT,
  accessToken: config.accessToken,
}).replaceAll("/", "\\/");
const { default: QRCode } = await import(
  join(root, "packages", "scenario", "node_modules", "qrcode", "lib", "index.js")
);
const output = join(secrets, "terminal-cloud-enrollment-qr.png");
await QRCode.toFile(output, `obterm2:${Buffer.from(canonical).toString("base64url")}`, {
  errorCorrectionLevel: "M",
  margin: 4,
  width: 720,
});
console.log(`Wrote ${output} (relay ${RELAY_ENDPOINT}, API ${config.apiEndpoint})`);
