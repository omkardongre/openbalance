import { z } from "zod";
import { FetchJsonTransport, type JsonTransport, partnerBaseUrl, scopedSegment } from "./http.js";

const order = z
  .object({
    code: z.string().min(1).max(64),
    status: z.enum(["n", "p", "e", "c"]),
    testmode: z.boolean(),
    datetime: z.string().datetime({ offset: true }),
    last_modified: z.string().datetime({ offset: true }),
    positions: z.array(
      z.object({ id: z.number().int().positive(), canceled: z.boolean() }).passthrough(),
    ),
  })
  .passthrough();

export type PretixAdmission = {
  orderCode: string;
  state: "PAID" | "PENDING" | "EXPIRED" | "CANCELLED";
  testMode: boolean;
  activePositionIds: number[];
  lastModified: string;
};

export class PretixClient {
  readonly #base: URL;
  readonly #organizer: string;
  readonly #event: string;
  readonly #token: string;
  readonly #transport: JsonTransport;

  constructor(input: {
    baseUrl: string;
    organizer: string;
    event: string;
    token: string;
    transport?: JsonTransport;
  }) {
    this.#base = partnerBaseUrl(input.baseUrl);
    this.#organizer = scopedSegment(input.organizer, "pretix organizer");
    this.#event = scopedSegment(input.event, "pretix event");
    if (!/^Token [A-Za-z0-9._~-]{20,512}$/.test(`Token ${input.token}`))
      throw new Error("Invalid pretix credential");
    this.#token = input.token;
    this.#transport = input.transport ?? new FetchJsonTransport(this.#base.origin);
  }

  async readAdmission(orderCode: string): Promise<PretixAdmission> {
    const code = scopedSegment(orderCode, "pretix order code");
    const url = new URL(
      `api/v1/organizers/${this.#organizer}/events/${this.#event}/orders/${code}/`,
      this.#base,
    );
    const result = order.parse(
      await this.#transport.request({
        method: "GET",
        url,
        headers: { Accept: "application/json", Authorization: `Token ${this.#token}` },
      }),
    );
    if (result.code !== orderCode) throw new Error("pretix returned another order");
    const states = { n: "PENDING", p: "PAID", e: "EXPIRED", c: "CANCELLED" } as const;
    return {
      orderCode: result.code,
      state: states[result.status],
      testMode: result.testmode,
      activePositionIds: result.positions
        .filter((position) => !position.canceled)
        .map(({ id }) => id),
      lastModified: result.last_modified,
    };
  }
}
