export type JsonRequest = {
  method: "GET" | "POST";
  url: URL;
  headers: Readonly<Record<string, string>>;
  body?: string;
};

export interface JsonTransport {
  request(input: JsonRequest): Promise<unknown>;
}

export class PartnerUnavailable extends Error {}
export class PartnerResponseRejected extends Error {}

export class FetchJsonTransport implements JsonTransport {
  constructor(
    private readonly allowedOrigin: string,
    private readonly timeoutMilliseconds = 10_000,
    private readonly maximumBytes = 1_048_576,
  ) {
    if (timeoutMilliseconds < 250 || timeoutMilliseconds > 30_000 || maximumBytes < 1_024)
      throw new Error("Invalid partner transport limits");
  }

  async request(input: JsonRequest): Promise<unknown> {
    if (input.url.origin !== this.allowedOrigin || input.url.username || input.url.password)
      throw new PartnerResponseRejected("Partner request escaped its configured origin");
    let response: Response;
    try {
      const request: RequestInit = {
        method: input.method,
        headers: input.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      };
      if (input.body !== undefined) request.body = input.body;
      response = await fetch(input.url, request);
    } catch {
      throw new PartnerUnavailable("Partner request failed");
    }
    if (response.status >= 300 && response.status < 400)
      throw new PartnerResponseRejected("Partner redirect is not allowed");
    if (!response.ok) throw new PartnerUnavailable(`Partner returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "application/json")
      throw new PartnerResponseRejected("Partner response is not JSON");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maximumBytes)
      throw new PartnerResponseRejected("Partner response exceeds the configured limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maximumBytes)
      throw new PartnerResponseRejected("Partner response exceeds the configured limit");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new PartnerResponseRejected("Partner response contains invalid JSON");
    }
  }
}

export function partnerBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Partner base URL is not allowed");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function scopedSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new Error(`Invalid ${name}`);
  return encodeURIComponent(value);
}
