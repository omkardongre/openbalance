function base64Url(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The terminal's enrollment code. Android checks it byte for byte against `JSONObject.toString()`. */
export function terminalSetupPayload(accessToken: string) {
  const api = process.env.NEXT_PUBLIC_API_URL;
  const rpc = process.env.NEXT_PUBLIC_FINANCIAL_RPC_URL;
  const relay = process.env.NEXT_PUBLIC_TERMINAL_RELAY_URL ?? process.env.NEXT_PUBLIC_RELAYER_URL;
  if (!api || !rpc || !relay) throw new Error("Terminal setup is not configured on this site.");
  const canonical = JSON.stringify({
    schemaVersion: 2,
    apiEndpoint: api,
    rpcEndpoint: rpc,
    relayEndpoint: `${relay}/v1/vouchers`,
    accessToken,
  }).replaceAll("/", "\\/");
  return `obterm2:${base64Url(canonical)}`;
}
