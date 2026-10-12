function base64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The only path the terminal accepts for uploads (`ProvisioningStore.relayEndpoint`). */
const VOUCHER_INGRESS_PATH = "/v1/vouchers";

/**
 * The relayer's voucher ingress for a configured relayer URL. The path is set here once, so the
 * build value may be the bare origin or already end in `/v1/vouchers` (an absolute path replaces
 * the base path rather than appending to it). The origin is kept as given: terminals sign every
 * upload over this exact URL.
 */
export function voucherIngressUrl(relay: string) {
  const url = new URL(VOUCHER_INGRESS_PATH, relay);
  if (url.protocol !== "https:") throw new Error("Terminal setup needs an HTTPS relayer URL.");
  return url.href;
}

/** Android drops a trailing slash before its byte-for-byte comparison, so the code must too. */
function withoutTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export type TerminalSetupEndpoints = { api: string; rpc: string; relay: string };

/** The terminal's enrollment code. Android checks it byte for byte against `JSONObject.toString()`. */
export function buildTerminalSetupPayload(endpoints: TerminalSetupEndpoints, accessToken: string) {
  const canonical = JSON.stringify({
    schemaVersion: 2,
    apiEndpoint: withoutTrailingSlash(endpoints.api),
    rpcEndpoint: withoutTrailingSlash(endpoints.rpc),
    relayEndpoint: voucherIngressUrl(endpoints.relay),
    accessToken,
  }).replaceAll("/", "\\/");
  return `obterm2:${base64Url(canonical)}`;
}

/** The enrollment code for this site's build-time endpoints. */
export function terminalSetupPayload(accessToken: string) {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const rpc = process.env.NEXT_PUBLIC_FINANCIAL_RPC_URL;
  const relay = process.env.NEXT_PUBLIC_TERMINAL_RELAY_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL;
  if (!api || !rpc || !relay) throw new Error("Terminal setup is not configured on this site.");
  return buildTerminalSetupPayload({ api, rpc, relay }, accessToken);
}
