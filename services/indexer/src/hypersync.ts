import { getAddress, type Hex } from "viem";
import { z } from "zod";
import type { FinalizedChainSource } from "./source.js";
import type {
  ConservationSnapshot,
  FinalizedBlock,
  IndexedContracts,
  RawChainLog,
} from "./types.js";

/**
 * Envio HyperSync as the indexer's log source.
 *
 * HyperSync only replaces `eth_getLogs`. Everything that decides what is final and what the money
 * adds up to stays on the RPC: the finalized head, canonical block hashes, the deployment manifest
 * check and the conservation reads. The indexer compares every log's block hash with the RPC's
 * canonical hash before committing, and the reconciler compares projected totals with the vault and
 * ledger read directly over RPC, so a wrong or incomplete HyperSync answer cannot become financial
 * history unnoticed.
 *
 * The JSON query API is used directly (no native client), with only the fields the decoder needs.
 */

/** HyperSync could not answer for the whole requested range; the caller may use the RPC instead. */
export class HyperSyncUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "HTTP" | "AUTH" | "RATE_LIMIT" | "BEHIND" | "NETWORK" | "INVALID_RESPONSE",
  ) {
    super(message);
  }
}

const LOG_FIELDS = [
  "block_number",
  "block_hash",
  "transaction_hash",
  "transaction_index",
  "log_index",
  "address",
  "data",
  "topic0",
  "topic1",
  "topic2",
  "topic3",
] as const;

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const topic = hash.nullish();
const index = z.number().int().nonnegative().safe();

const responseSchema = z.object({
  archive_height: z.number().int().nonnegative().safe().nullish(),
  next_block: z.number().int().nonnegative().safe(),
  data: z.array(
    z.object({
      logs: z
        .array(
          z.object({
            block_number: index,
            block_hash: hash,
            transaction_hash: hash,
            transaction_index: index,
            log_index: index,
            address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
            data: hex,
            topic0: topic,
            topic1: topic,
            topic2: topic,
            topic3: topic,
          }),
        )
        .optional(),
    }),
  ),
});

type HyperSyncLog = NonNullable<z.infer<typeof responseSchema>["data"][number]["logs"]>[number];

export type HyperSyncLogClientOptions = {
  /** Chain endpoint, for example `https://monad-testnet.hypersync.xyz`. */
  url: string;
  apiToken: string;
  contracts: IndexedContracts;
  timeoutMilliseconds?: number;
  /** Upper bound on pages for one range; a range that needs more is reported as unavailable. */
  maximumPages?: number;
  /** Longest wait for the rate-limit window to reset before giving up with `RATE_LIMIT`. */
  maximumRateLimitWaitMilliseconds?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

function toRawLog(log: HyperSyncLog): RawChainLog {
  // Topics are positional: a missing topic ends the list, and a later one after a gap is malformed.
  const topics: Hex[] = [];
  let ended = false;
  for (const value of [log.topic0, log.topic1, log.topic2, log.topic3]) {
    if (value === null || value === undefined) ended = true;
    else if (ended)
      throw new HyperSyncUnavailable("HyperSync log topics have a gap", "INVALID_RESPONSE");
    else topics.push(value as Hex);
  }
  return {
    address: getAddress(log.address),
    data: log.data as Hex,
    topics,
    blockNumber: BigInt(log.block_number),
    blockHash: log.block_hash as Hex,
    transactionHash: log.transaction_hash as Hex,
    transactionIndex: log.transaction_index,
    logIndex: log.log_index,
  };
}

export class HyperSyncLogClient {
  readonly #endpoint: string;
  readonly #apiToken: string;
  readonly #addresses: readonly string[];
  readonly #timeout: number;
  readonly #maximumPages: number;
  readonly #fetch: typeof fetch;
  readonly #maximumRateLimitWait: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  /** When the token's budget window resets, once the client knows it cannot afford a query. */
  #budgetResetAt: number | null = null;

  constructor(options: HyperSyncLogClientOptions) {
    const url = URL.canParse(options.url) ? new URL(options.url) : null;
    if (!url || url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "")
      throw new Error("Invalid HyperSync URL");
    if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(options.apiToken))
      throw new Error("Invalid HyperSync API token");
    this.#endpoint = `${url.origin}/query`;
    this.#apiToken = options.apiToken;
    this.#addresses = [
      options.contracts.router,
      options.contracts.ledger,
      options.contracts.vault,
    ].map((address) => getAddress(address).toLowerCase());
    this.#timeout = options.timeoutMilliseconds ?? 15_000;
    this.#maximumPages = options.maximumPages ?? 64;
    this.#fetch = options.fetch ?? fetch;
    this.#maximumRateLimitWait = options.maximumRateLimitWaitMilliseconds ?? 65_000;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#now = options.now ?? Date.now;
  }

  /** Every log the three contracts emitted in `[fromBlock, toBlock]`, inclusive like `eth_getLogs`. */
  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<RawChainLog[]> {
    if (fromBlock < 0n || toBlock < fromBlock || toBlock >= BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Invalid HyperSync block range");
    // HyperSync's `to_block` is exclusive and a page ends wherever its time or size limit falls, so
    // the range is walked with `next_block` until it reaches the end.
    const end = Number(toBlock) + 1;
    let next = Number(fromBlock);
    const logs: RawChainLog[] = [];
    for (let page = 0; next < end; page++) {
      if (page >= this.#maximumPages)
        throw new HyperSyncUnavailable("HyperSync range needed too many pages", "INVALID_RESPONSE");
      const response = await this.#query(next, end);
      if (response.next_block <= next || response.next_block > end) {
        // No progress means HyperSync has not ingested this range yet.
        const height = response.archive_height ?? null;
        throw new HyperSyncUnavailable(
          `HyperSync is behind the finalized head (archive height ${height ?? "unknown"}, need ${toBlock})`,
          "BEHIND",
        );
      }
      for (const batch of response.data)
        for (const log of batch.logs ?? []) {
          const raw = toRawLog(log);
          if (!this.#addresses.includes(raw.address.toLowerCase()))
            throw new HyperSyncUnavailable(
              "HyperSync returned a log from another contract",
              "INVALID_RESPONSE",
            );
          if (raw.blockNumber < BigInt(next) || raw.blockNumber >= BigInt(response.next_block))
            throw new HyperSyncUnavailable(
              "HyperSync returned a log outside its page",
              "INVALID_RESPONSE",
            );
          logs.push(raw);
        }
      next = response.next_block;
    }
    return logs;
  }

  /** The highest block HyperSync has ingested. */
  async getHeight(): Promise<bigint> {
    const body = await this.#request(
      `${this.#endpoint.slice(0, -"/query".length)}/height`,
      undefined,
    );
    const parsed = z.object({ height: z.number().int().nonnegative().safe() }).safeParse(body);
    if (!parsed.success)
      throw new HyperSyncUnavailable(
        "HyperSync height has an unexpected shape",
        "INVALID_RESPONSE",
      );
    return BigInt(parsed.data.height);
  }

  async #query(fromBlock: number, toBlock: number): Promise<z.infer<typeof responseSchema>> {
    const body = await this.#request(this.#endpoint, {
      from_block: fromBlock,
      to_block: toBlock,
      logs: [{ address: this.#addresses }],
      field_selection: { log: LOG_FIELDS },
      join_mode: "JoinNothing",
    });
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success)
      throw new HyperSyncUnavailable(
        "HyperSync response has an unexpected shape",
        "INVALID_RESPONSE",
      );
    return parsed.data;
  }

  /**
   * Each token has a unit budget per 60-second window (free plan: 15,000 units, 1,000 per query).
   * The client reads the `x-ratelimit-*` headers and, once the window cannot afford another query,
   * waits for it to reset instead of sending a request that would only return 429. A 429 that still
   * arrives is waited out and retried once. Waits longer than `maximumRateLimitWaitMilliseconds`
   * are reported as `RATE_LIMIT`, so the caller can use the RPC instead.
   */
  async #request(url: string, query: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.#waitForBudget();
      const response = await this.#send(url, query);
      this.#recordBudget(response);
      if (response.status === 429 && attempt === 0) {
        this.#budgetResetAt ??= this.#now() + 60_000;
        continue;
      }
      return this.#read(response);
    }
  }

  async #waitForBudget(): Promise<void> {
    if (this.#budgetResetAt === null) return;
    const wait = this.#budgetResetAt - this.#now();
    if (wait > this.#maximumRateLimitWait)
      throw new HyperSyncUnavailable("HyperSync rate limit reached", "RATE_LIMIT");
    if (wait > 0) await this.#sleep(wait);
    this.#budgetResetAt = null;
  }

  #recordBudget(response: Response): void {
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const cost = Number(response.headers.get("x-ratelimit-cost") ?? "0");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (!Number.isFinite(reset) || !response.headers.has("x-ratelimit-reset")) return;
    // `reset` is seconds until the window resets; one extra second absorbs clock granularity.
    if (response.status === 429 || (Number.isFinite(remaining) && remaining < Math.max(cost, 1)))
      this.#budgetResetAt = this.#now() + (Math.max(reset, 0) + 1) * 1_000;
  }

  async #send(url: string, query: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: query === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.#apiToken}`,
          accept: "application/json",
          ...(query === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(query === undefined ? {} : { body: JSON.stringify(query) }),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      // The token is in the request headers, so the underlying error is never echoed.
      throw new HyperSyncUnavailable("HyperSync request failed", "NETWORK");
    }
    return response;
  }

  async #read(response: Response): Promise<unknown> {
    if (response.status === 401 || response.status === 403)
      throw new HyperSyncUnavailable(
        `HyperSync rejected the API token (HTTP ${response.status})`,
        "AUTH",
      );
    if (response.status === 429)
      throw new HyperSyncUnavailable("HyperSync rate limit reached", "RATE_LIMIT");
    if (!response.ok)
      throw new HyperSyncUnavailable(`HyperSync returned HTTP ${response.status}`, "HTTP");
    try {
      return await response.json();
    } catch {
      throw new HyperSyncUnavailable("HyperSync returned invalid JSON", "INVALID_RESPONSE");
    }
  }
}

export type HyperSyncFallback = (
  error: HyperSyncUnavailable,
  fromBlock: bigint,
  toBlock: bigint,
) => void;

/**
 * A finalized chain source whose logs come from HyperSync and everything else from the RPC source.
 * When HyperSync cannot answer, the batch is read from the RPC instead and `onFallback` is told, so
 * an Envio outage slows nothing down and is still visible.
 *
 * HyperSync trails the finalized head by a few blocks on Monad testnet (measured 1 to 4, under two
 * seconds). The finalized head itself always comes from the RPC and is never adjusted, because a head
 * that moved backwards after a restart would read as contradicted history. Instead, a batch that
 * ends past what HyperSync has ingested waits up to `catchUpMilliseconds` for it, then falls back.
 */
export class HyperSyncFinalizedChainSource implements FinalizedChainSource {
  readonly #rpc: FinalizedChainSource;
  readonly #hypersync: Pick<HyperSyncLogClient, "getLogs" | "getHeight">;
  readonly #onFallback: HyperSyncFallback;
  readonly #onSuccess: (fromBlock: bigint, toBlock: bigint, logCount: number) => void;
  readonly #catchUp: number;
  readonly #pollInterval: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: {
    rpc: FinalizedChainSource;
    hypersync: Pick<HyperSyncLogClient, "getLogs" | "getHeight">;
    onFallback?: HyperSyncFallback;
    onSuccess?: (fromBlock: bigint, toBlock: bigint, logCount: number) => void;
    catchUpMilliseconds?: number;
    pollIntervalMilliseconds?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    this.#rpc = options.rpc;
    this.#hypersync = options.hypersync;
    this.#onFallback = options.onFallback ?? (() => {});
    this.#onSuccess = options.onSuccess ?? (() => {});
    this.#catchUp = options.catchUpMilliseconds ?? 3_000;
    this.#pollInterval = options.pollIntervalMilliseconds ?? 250;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  assertManifest(input: {
    chainId: bigint;
    eventId: Hex;
    contracts: IndexedContracts;
  }): Promise<void> {
    return this.#rpc.assertManifest(input);
  }

  getFinalizedHead(): Promise<FinalizedBlock> {
    return this.#rpc.getFinalizedHead();
  }

  getLatestHead(): Promise<FinalizedBlock> {
    return this.#rpc.getLatestHead();
  }

  getBlock(blockNumber: bigint): Promise<FinalizedBlock> {
    return this.#rpc.getBlock(blockNumber);
  }

  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<RawChainLog[]> {
    try {
      await this.#waitForHeight(toBlock);
      const logs = await this.#hypersync.getLogs(fromBlock, toBlock);
      this.#onSuccess(fromBlock, toBlock, logs.length);
      return logs;
    } catch (error) {
      if (!(error instanceof HyperSyncUnavailable)) throw error;
      this.#onFallback(error, fromBlock, toBlock);
      return this.#rpc.getLogs(fromBlock, toBlock);
    }
  }

  readConservation(blockNumber: bigint): Promise<ConservationSnapshot> {
    return this.#rpc.readConservation(blockNumber);
  }

  /** Resolves once HyperSync has ingested past `toBlock`; throws `BEHIND` if it does not in time. */
  async #waitForHeight(toBlock: bigint): Promise<void> {
    // The reported height is treated as possibly still being ingested, so `toBlock` must be below it.
    let waited = 0;
    for (;;) {
      const height = await this.#hypersync.getHeight();
      if (height > toBlock) return;
      if (waited >= this.#catchUp)
        throw new HyperSyncUnavailable(
          `HyperSync is behind the finalized head (height ${height}, need ${toBlock + 1n})`,
          "BEHIND",
        );
      await this.#sleep(this.#pollInterval);
      waited += this.#pollInterval;
    }
  }
}
