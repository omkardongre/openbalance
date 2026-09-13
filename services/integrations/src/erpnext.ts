import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { FetchJsonTransport, type JsonTransport, partnerBaseUrl } from "./http.js";

const receipt = z.object({
  transition_id: z.string().min(1).max(256),
  company: z.string().min(1).max(140),
  sales_invoice: z.string().min(1).max(140),
  payment_entry: z.string().min(1).max(140),
  payment_id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  amount_units: z.string().regex(/^[1-9][0-9]*$/),
  asset_code: z.string().min(1).max(32),
  chain_id: z.string().regex(/^[1-9][0-9]*$/),
  transaction_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  docstatus: z.literal(1),
});
const response = z.object({ message: receipt });

export type FinalizedPaymentWrite = {
  transitionId: string;
  company: string;
  orderReference: string;
  paymentId: Hex;
  payer: `0x${string}`;
  amountUnits: bigint;
  assetCode: string;
  chainId: bigint;
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
};

export class ErpNextClient {
  readonly #base: URL;
  readonly #authorization: string;
  readonly #method: string;
  readonly #transport: JsonTransport;

  constructor(input: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
    method?: string;
    transport?: JsonTransport;
  }) {
    this.#base = partnerBaseUrl(input.baseUrl);
    if (!/^[A-Za-z0-9._~-]{8,256}$/.test(input.apiKey) || input.apiSecret.length < 16)
      throw new Error("Invalid ERPNext credential");
    this.#authorization = `token ${input.apiKey}:${input.apiSecret}`;
    const method = input.method ?? "openbalance.api.record_finalized_payment";
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){2,7}$/.test(method))
      throw new Error("Invalid ERPNext method");
    this.#method = method;
    this.#transport = input.transport ?? new FetchJsonTransport(this.#base.origin);
  }

  async recordFinalizedPayment(input: FinalizedPaymentWrite) {
    validateWrite(input);
    const body = JSON.stringify({
      transition_id: input.transitionId,
      company: input.company,
      order_reference: input.orderReference,
      payment_id: input.paymentId.toLowerCase(),
      payer: getAddress(input.payer),
      amount_units: input.amountUnits.toString(),
      asset_code: input.assetCode,
      chain_id: input.chainId.toString(),
      transaction_hash: input.transactionHash.toLowerCase(),
      block_number: input.blockNumber.toString(),
      block_hash: input.blockHash.toLowerCase(),
    });
    const url = new URL(`api/method/${this.#method}`, this.#base);
    const written = response.parse(
      await this.#transport.request({
        method: "POST",
        url,
        headers: {
          Accept: "application/json",
          Authorization: this.#authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": input.transitionId,
        },
        body,
      }),
    ).message;
    const readBackUrl = new URL(`api/method/${this.#method}`, this.#base);
    readBackUrl.searchParams.set("transition_id", input.transitionId);
    const readBack = response.parse(
      await this.#transport.request({
        method: "GET",
        url: readBackUrl,
        headers: { Accept: "application/json", Authorization: this.#authorization },
      }),
    ).message;
    const expected = {
      transition_id: input.transitionId,
      company: input.company,
      payment_id: input.paymentId.toLowerCase(),
      amount_units: input.amountUnits.toString(),
      asset_code: input.assetCode,
      chain_id: input.chainId.toString(),
      transaction_hash: input.transactionHash.toLowerCase(),
      docstatus: 1,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (readBack[key as keyof typeof readBack] !== value)
        throw new Error(`ERPNext read-back mismatch for ${key}`);
    }
    if (
      written.payment_entry !== readBack.payment_entry ||
      written.sales_invoice !== readBack.sales_invoice
    )
      throw new Error("ERPNext write acknowledgement disagrees with read-back");
    return {
      transitionId: readBack.transition_id,
      salesInvoice: readBack.sales_invoice,
      paymentEntry: readBack.payment_entry,
      readBack: true as const,
    };
  }
}

function validateWrite(input: FinalizedPaymentWrite) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(input.transitionId) ||
    input.company.length < 1 ||
    input.company.length > 140 ||
    input.orderReference.length < 1 ||
    input.orderReference.length > 160 ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.paymentId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.blockHash) ||
    input.amountUnits <= 0n ||
    input.chainId <= 0n ||
    input.blockNumber < 0n ||
    !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(input.assetCode)
  )
    throw new Error("Invalid finalized payment write");
  getAddress(input.payer);
}
