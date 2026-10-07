import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadIndexerConfig } from "../src/config.js";
import {
  HyperSyncFinalizedChainSource,
  HyperSyncLogClient,
  HyperSyncUnavailable,
} from "../src/hypersync.js";
import type { FinalizedChainSource } from "../src/source.js";
import type { RawChainLog } from "../src/types.js";

const contracts = {
  router: "0x1111111111111111111111111111111111111111",
  ledger: "0x2222222222222222222222222222222222222222",
  vault: "0x3333333333333333333333333333333333333333",
} as const;
const h = (nibble: string) => `0x${nibble.repeat(64)}`;

function wireLog(blockNumber: number, logIndex: number, overrides: Record<string, unknown> = {}) {
  return {
    block_number: blockNumber,
    block_hash: h("b"),
    transaction_hash: h("c"),
    transaction_index: 0,
    log_index: logIndex,
    address: contracts.vault,
    data: "0x01",
    topic0: h("a"),
    topic1: h("d"),
    topic2: null,
    topic3: null,
    ...overrides,
  };
}

type Call = { url: string; body: Record<string, unknown> | undefined; auth: string | null };

function fakeFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init.headers).get("authorization"),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

function client(fetcher: typeof fetch) {
  return new HyperSyncLogClient({
    url: "https://monad-testnet.hypersync.xyz",
    apiToken: "test-token-123",
    contracts,
    fetch: fetcher,
  });
}

describe("HyperSyncLogClient", () => {
  it("walks next_block pages and maps logs to the RPC shape", async () => {
    const { calls, fetcher } = fakeFetch([
      { body: { archive_height: 500, next_block: 105, data: [{ logs: [wireLog(101, 2)] }] } },
      { body: { archive_height: 500, next_block: 111, data: [{ logs: [wireLog(110, 0)] }, {}] } },
    ]);
    const logs = await client(fetcher).getLogs(100n, 110n);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://monad-testnet.hypersync.xyz/query");
    expect(calls[0]?.auth).toBe("Bearer test-token-123");
    // `to_block` is exclusive on HyperSync, inclusive on eth_getLogs.
    expect(calls[0]?.body).toMatchObject({
      from_block: 100,
      to_block: 111,
      join_mode: "JoinNothing",
    });
    expect(calls[1]?.body).toMatchObject({ from_block: 105, to_block: 111 });
    expect(calls[0]?.body?.logs).toEqual([
      { address: [contracts.router, contracts.ledger, contracts.vault] },
    ]);
    expect(logs).toEqual<RawChainLog[]>([
      {
        address: "0x3333333333333333333333333333333333333333",
        data: "0x01",
        topics: [h("a"), h("d")] as RawChainLog["topics"],
        blockNumber: 101n,
        blockHash: h("b") as RawChainLog["blockHash"],
        transactionHash: h("c") as RawChainLog["transactionHash"],
        transactionIndex: 0,
        logIndex: 2,
      },
      expect.objectContaining({ blockNumber: 110n, logIndex: 0 }),
    ]);
  });

  it("reports BEHIND when a page makes no progress", async () => {
    const { fetcher } = fakeFetch([{ body: { archive_height: 100, next_block: 100, data: [] } }]);
    await expect(client(fetcher).getLogs(100n, 110n)).rejects.toMatchObject({ reason: "BEHIND" });
  });

  it("rejects logs from another contract, outside the page, or with topic gaps", async () => {
    for (const bad of [
      wireLog(101, 0, { address: "0x4444444444444444444444444444444444444444" }),
      wireLog(99, 0),
      wireLog(101, 0, { topic1: null, topic2: h("e") }),
    ]) {
      const { fetcher } = fakeFetch([{ body: { next_block: 111, data: [{ logs: [bad] }] } }]);
      await expect(client(fetcher).getLogs(100n, 110n)).rejects.toMatchObject({
        reason: "INVALID_RESPONSE",
      });
    }
  });

  it("classifies HTTP failures without echoing the token", async () => {
    for (const [status, reason] of [
      [401, "AUTH"],
      [429, "RATE_LIMIT"],
      [503, "HTTP"],
    ] as const) {
      // A 429 whose window resets later than the client waits is reported, not slept through.
      const { fetcher } = fakeFetch([
        { status, body: {}, headers: { "x-ratelimit-reset": "300" } },
      ]);
      const error = await client(fetcher)
        .getLogs(1n, 2n)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HyperSyncUnavailable);
      expect(error).toMatchObject({ reason });
      expect(String((error as Error).message)).not.toContain("test-token-123");
    }
  });

  it("waits for the rate-limit window instead of spending a query it cannot afford", async () => {
    let now = 0;
    const slept: number[] = [];
    const calls: number[] = [];
    const page = { next_block: 111, data: [] };
    const responses = [
      // Last affordable query in this window: remaining 0 < cost 1000, resets in 20 s.
      {
        status: 200,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-cost": "1000",
          "x-ratelimit-reset": "20",
        },
      },
      // A 429 regardless (another process shares the token): wait it out and retry once.
      { status: 429, headers: { "x-ratelimit-reset": "5" } },
      { status: 200, headers: {} },
    ];
    const fetcher = (async () => {
      calls.push(now);
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return new Response(JSON.stringify(page), { status: next.status, headers: next.headers });
    }) as unknown as typeof fetch;
    const paced = new HyperSyncLogClient({
      url: "https://monad-testnet.hypersync.xyz",
      apiToken: "test-token-123",
      contracts,
      fetch: fetcher,
      now: () => now,
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
        now += milliseconds;
      },
    });
    await paced.getLogs(100n, 110n);
    await paced.getLogs(100n, 110n);
    expect(slept).toEqual([21_000, 6_000]);
    expect(calls).toEqual([0, 21_000, 27_000]);
  });

  it("reports RATE_LIMIT when the window resets later than it is willing to wait", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ next_block: 111, data: [] }), {
        status: 429,
        headers: { "x-ratelimit-reset": "50" },
      })) as unknown as typeof fetch;
    const impatient = new HyperSyncLogClient({
      url: "https://monad-testnet.hypersync.xyz",
      apiToken: "test-token-123",
      contracts,
      fetch: fetcher,
      maximumRateLimitWaitMilliseconds: 10_000,
      sleep: async () => {},
    });
    await expect(impatient.getLogs(100n, 110n)).rejects.toMatchObject({ reason: "RATE_LIMIT" });
  });

  it("rejects non-HTTPS endpoints and malformed tokens", () => {
    expect(
      () =>
        new HyperSyncLogClient({
          url: "http://x.hypersync.xyz",
          apiToken: "test-token-123",
          contracts,
        }),
    ).toThrow();
    expect(
      () =>
        new HyperSyncLogClient({
          url: "https://x.hypersync.xyz",
          apiToken: "bad token",
          contracts,
        }),
    ).toThrow();
  });
});

describe("HyperSyncFinalizedChainSource", () => {
  const rpcLogs: RawChainLog[] = [];
  const rpc = {
    getLogs: async () => rpcLogs,
    getFinalizedHead: async () => ({
      number: 200n,
      hash: h("1"),
      parentHash: h("2"),
      timestamp: 1n,
    }),
  } as unknown as FinalizedChainSource;
  const noSleep = async () => {};

  it("waits for HyperSync to ingest the batch, then uses it", async () => {
    const heights = [109n, 110n, 111n];
    const fallbacks: string[] = [];
    let successes = 0;
    const source = new HyperSyncFinalizedChainSource({
      rpc,
      hypersync: { getHeight: async () => heights.shift() ?? 111n, getLogs: async () => [] },
      onFallback: (error) => fallbacks.push(error.reason),
      onSuccess: () => successes++,
      sleep: noSleep,
    });
    await source.getLogs(100n, 110n);
    expect(heights).toEqual([]);
    expect(successes).toBe(1);
    expect(fallbacks).toEqual([]);
  });

  it("falls back to the RPC when HyperSync stays behind or fails", async () => {
    const fallbacks: string[] = [];
    const behind = new HyperSyncFinalizedChainSource({
      rpc,
      hypersync: { getHeight: async () => 50n, getLogs: async () => [] },
      onFallback: (error) => fallbacks.push(error.reason),
      catchUpMilliseconds: 500,
      sleep: noSleep,
    });
    expect(await behind.getLogs(100n, 110n)).toBe(rpcLogs);
    const failing = new HyperSyncFinalizedChainSource({
      rpc,
      hypersync: {
        getHeight: async () => 1_000n,
        getLogs: async () => {
          throw new HyperSyncUnavailable("down", "HTTP");
        },
      },
      onFallback: (error) => fallbacks.push(error.reason),
    });
    expect(await failing.getLogs(100n, 110n)).toBe(rpcLogs);
    expect(fallbacks).toEqual(["BEHIND", "HTTP"]);
  });

  it("never takes the finalized head from HyperSync", async () => {
    const source = new HyperSyncFinalizedChainSource({
      rpc,
      hypersync: { getHeight: async () => 1n, getLogs: async () => [] },
    });
    expect((await source.getFinalizedHead()).number).toBe(200n);
  });
});

describe("indexer config", () => {
  const base = {
    INDEXER_DATABASE_URL: "postgres://localhost/test",
    INDEXER_RPC_URL: "https://rpc.example",
    INDEXER_CHAIN_ID: "10143",
    INDEXER_CHAIN_NAME: "Monad Testnet",
    INDEXER_ENVIRONMENT: "testnet",
    INDEXER_EVENT_ID: h("e"),
    INDEXER_ROUTER_ADDRESS: contracts.router,
    INDEXER_LEDGER_ADDRESS: contracts.ledger,
    INDEXER_VAULT_ADDRESS: contracts.vault,
    INDEXER_DEPLOYMENT_BLOCK: "1",
  };
  const hypersync = {
    INDEXER_HYPERSYNC_URL: "https://monad-testnet.hypersync.xyz",
    ENVIO_API_TOKEN: "test-token-123",
  };

  it("keeps RPC-sized batches without HyperSync and widens them with it", () => {
    const rpcOnly = loadIndexerConfig(base);
    expect(rpcOnly.hypersync).toBeUndefined();
    expect(rpcOnly.batchSize).toBe(500);
    const withHyperSync = loadIndexerConfig({ ...base, ...hypersync });
    expect(withHyperSync.hypersync).toMatchObject({ url: hypersync.INDEXER_HYPERSYNC_URL });
    expect(withHyperSync.batchSize).toBe(1_000_000);
    expect(withHyperSync.rpcLogRange).toBe(500);
    expect(rpcOnly.pollIntervalMilliseconds).toBe(2_000);
    expect(withHyperSync.pollIntervalMilliseconds).toBe(5_000);
  });

  it("reads the token from a mounted secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "hypersync-"));
    const path = join(directory, "envio-api-token");
    writeFileSync(path, "file-token-123\n", { mode: 0o600 });
    try {
      const config = loadIndexerConfig({
        ...base,
        INDEXER_HYPERSYNC_URL: hypersync.INDEXER_HYPERSYNC_URL,
        INDEXER_HYPERSYNC_TOKEN_PATH: path,
      });
      expect(config.hypersync?.apiToken).toBe("file-token-123");
      expect(() =>
        loadIndexerConfig({ ...base, ...hypersync, INDEXER_HYPERSYNC_TOKEN_PATH: path }),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects half a HyperSync configuration and oversized RPC batches", () => {
    expect(() => loadIndexerConfig({ ...base, ENVIO_API_TOKEN: "test-token-123" })).toThrow();
    expect(() =>
      loadIndexerConfig({ ...base, INDEXER_HYPERSYNC_URL: hypersync.INDEXER_HYPERSYNC_URL }),
    ).toThrow();
    expect(() => loadIndexerConfig({ ...base, INDEXER_BATCH_SIZE: "5000" })).toThrow();
    expect(() =>
      loadIndexerConfig({ ...base, ...hypersync, INDEXER_HYPERSYNC_URL: "http://x.hypersync.xyz" }),
    ).toThrow();
  });
});
