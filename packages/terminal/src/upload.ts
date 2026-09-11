import { randomBytes } from "node:crypto";
import {
  terminalIngressDigest,
  type VoucherReceipt,
  voucherReceiptPayloadHash,
} from "@openbalance/protocol";
import { bytesToHex, type Hex } from "viem";
import type { StoredUploadAuthorization, TerminalJournal, TerminalSale } from "./journal.js";

export interface TerminalTransportSigner {
  sign(input: { hash: Hex }): Promise<Hex>;
}

export type RelayUploadClientOptions = {
  journal: TerminalJournal;
  endpoint: string;
  audience: string;
  keyVersion: bigint;
  signer: TerminalTransportSigner;
  owner: string;
  fetch?: typeof fetch;
  now?: () => number;
  leaseMilliseconds?: number;
  requestTimeoutMilliseconds?: number;
  initialBackoffMilliseconds?: number;
  maximumBackoffMilliseconds?: number;
  maximumAuthorizationAgeSeconds?: number;
};

export type UploadOutcome = {
  requestId: string;
  state: "UPLOADED" | "RETRY" | "QUARANTINED";
  statusCode: number | null;
};

function safeError(error: unknown): string {
  if (error instanceof Error) return (error.message || error.name).slice(0, 500);
  return "Relay upload failed";
}

async function relayAcknowledgement(response: Response): Promise<unknown> {
  const maximumBytes = 16 * 1_024;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maximumBytes)
    throw new Error("Relay acknowledgement exceeds supported size");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes)
    throw new Error("Relay acknowledgement exceeds supported size");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Relay acknowledgement is not valid JSON");
  }
}

export class RelayUploadClient {
  readonly #options: Required<
    Pick<
      RelayUploadClientOptions,
      | "journal"
      | "endpoint"
      | "audience"
      | "keyVersion"
      | "signer"
      | "owner"
      | "fetch"
      | "now"
      | "leaseMilliseconds"
      | "requestTimeoutMilliseconds"
      | "initialBackoffMilliseconds"
      | "maximumBackoffMilliseconds"
      | "maximumAuthorizationAgeSeconds"
    >
  >;

  constructor(options: RelayUploadClientOptions) {
    const endpoint = URL.canParse(options.endpoint) ? new URL(options.endpoint) : null;
    if (
      endpoint?.protocol !== "https:" ||
      !URL.canParse(options.audience) ||
      options.endpoint !== options.audience ||
      options.keyVersion <= 0n ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(options.owner) ||
      (options.leaseMilliseconds ?? 30_000) < 1_000 ||
      (options.requestTimeoutMilliseconds ?? 10_000) < 500 ||
      (options.initialBackoffMilliseconds ?? 2_000) < 1_000 ||
      (options.maximumBackoffMilliseconds ?? 300_000) <
        (options.initialBackoffMilliseconds ?? 2_000) ||
      (options.maximumAuthorizationAgeSeconds ?? 60) < 10
    )
      throw new Error("Invalid relay upload configuration");
    this.#options = {
      ...options,
      fetch: options.fetch ?? fetch,
      now: options.now ?? Date.now,
      leaseMilliseconds: options.leaseMilliseconds ?? 30_000,
      requestTimeoutMilliseconds: options.requestTimeoutMilliseconds ?? 10_000,
      initialBackoffMilliseconds: options.initialBackoffMilliseconds ?? 2_000,
      maximumBackoffMilliseconds: options.maximumBackoffMilliseconds ?? 300_000,
      maximumAuthorizationAgeSeconds: options.maximumAuthorizationAgeSeconds ?? 60,
    };
  }

  async runBatch(limit: number): Promise<UploadOutcome[]> {
    const now = this.#options.now();
    const sales = this.#options.journal.leaseUploads(
      limit,
      this.#options.owner,
      now,
      this.#options.leaseMilliseconds,
    );
    const outcomes: UploadOutcome[] = [];
    for (const sale of sales) outcomes.push(await this.#upload(sale));
    return outcomes;
  }

  async #authorization(
    sale: TerminalSale,
    receipt: VoucherReceipt,
    now: number,
  ): Promise<StoredUploadAuthorization> {
    const nowSeconds = Math.floor(now / 1_000);
    const current = sale.uploadAuthorization;
    if (
      current &&
      current.keyVersion === this.#options.keyVersion.toString() &&
      Math.abs(nowSeconds - current.sentAt) <= this.#options.maximumAuthorizationAgeSeconds
    )
      return current;
    const nonce = bytesToHex(randomBytes(32));
    const authorization = {
      keyVersion: this.#options.keyVersion.toString(),
      sentAt: nowSeconds,
      nonce,
      signature: await this.#options.signer.sign({
        hash: terminalIngressDigest({
          audience: this.#options.audience,
          terminalId: receipt.terminalId,
          keyVersion: this.#options.keyVersion,
          sentAt: nowSeconds,
          nonce,
          payloadHash: `0x${voucherReceiptPayloadHash(receipt)}`,
        }),
      }),
    } satisfies StoredUploadAuthorization;
    this.#options.journal.saveUploadAuthorization(
      sale.requestId,
      this.#options.owner,
      authorization,
      now,
    );
    return authorization;
  }

  async #upload(sale: TerminalSale): Promise<UploadOutcome> {
    const now = this.#options.now();
    if (!sale.receipt)
      return this.#quarantine(sale, "Accepted sale is missing its complete receipt", now, null);
    try {
      const authorization = await this.#authorization(sale, sale.receipt, now);
      const response = await this.#options.fetch(this.#options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receipt: sale.receipt, authorization }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(this.#options.requestTimeoutMilliseconds),
      });
      if (response.status === 200 || response.status === 201) {
        const body = await relayAcknowledgement(response);
        if (
          typeof body !== "object" ||
          body === null ||
          !("receiptId" in body) ||
          body.receiptId !== sale.receipt.receiptId
        )
          return this.#retry(sale, "Relay acknowledgement is invalid", now, response.status);
        this.#options.journal.markUploaded(sale.requestId, this.#options.owner, now);
        return { requestId: sale.requestId, state: "UPLOADED", statusCode: response.status };
      }
      if ([400, 401, 403, 409, 422].includes(response.status))
        return this.#quarantine(
          sale,
          `Relay permanently rejected voucher with HTTP ${response.status}`,
          now,
          response.status,
        );
      return this.#retry(sale, `Relay returned HTTP ${response.status}`, now, response.status);
    } catch (error) {
      return this.#retry(sale, safeError(error), now, null);
    }
  }

  #retry(
    sale: TerminalSale,
    reason: string,
    now: number,
    statusCode: number | null,
  ): UploadOutcome {
    const exponent = Math.min(Math.max(0, sale.attempts - 1), 20);
    const delay = Math.min(
      this.#options.initialBackoffMilliseconds * 2 ** exponent,
      this.#options.maximumBackoffMilliseconds,
    );
    this.#options.journal.retryUpload(
      sale.requestId,
      this.#options.owner,
      now + delay,
      reason.slice(0, 500),
      now,
    );
    return { requestId: sale.requestId, state: "RETRY", statusCode };
  }

  #quarantine(
    sale: TerminalSale,
    reason: string,
    now: number,
    statusCode: number | null,
  ): UploadOutcome {
    this.#options.journal.quarantine(sale.requestId, this.#options.owner, reason, now);
    return { requestId: sale.requestId, state: "QUARANTINED", statusCode };
  }
}
