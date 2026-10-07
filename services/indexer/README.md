# OpenBalance finalized indexer

This service turns finalized contract events into durable PostgreSQL projections, balanced journal
entries, and a transactional outbox. It independently compares projected ledger and vault totals
with contract state at the exact indexed block.

## Guarantees

- Indexing begins at the deployment manifest block and advances one durable cursor per event stream.
- A batch stores decoded logs, domain projections, journal entries, outbox records, and its cursor in
  one PostgreSQL transaction.
- Restarting reuses the committed cursor. Duplicate transition identities are not projected twice.
- A hash contradiction at the stored finalized cursor creates a critical incident and stops indexing.
- Payment, reserve, voucher, reclaim, refund, and withdrawal changes update nonnegative projected
  liabilities using exact integer units.
- Every financial transition has equal debit and credit totals enforced by PostgreSQL.
- Reconciliation reads `totalLiability` and `totalReserved` at the exact cursor block. Differences
  remain visible and create an open integrity incident.
- Optional latest-head observations live in separate provisional tables. Reorganizations replace
  only that provisional tail, and the service stops if the configured rewind bound is exceeded.
- A finalized boundary is marked verified only when its canonical block hash and transition set
  match the separately indexed finalized history. No worker consumes provisional records.
- Projection repair rebuilds through the normal finalized decoder into an isolated PostgreSQL
  schema. It records source and shadow fingerprints plus an approval digest; promotion rechecks the
  cursor, history, fingerprints, and digest under a stream lock before replacing only projections.

## Envio HyperSync log source

With `INDEXER_HYPERSYNC_URL` set, finalized logs come from
[Envio HyperSync](https://docs.envio.dev/docs/HyperSync/overview) instead of `eth_getLogs`. Only the
logs move. The finalized head, canonical block hashes, the deployment manifest check and the
conservation reads all stay on the RPC, so HyperSync is never the sole source of financial truth:

- Every HyperSync log's block hash is compared with the RPC's canonical hash before the batch commits.
- The reconciler compares projected totals with `totalLiability` and `totalReserved` read over RPC.
- A batch is read only once HyperSync has ingested past it (it trails the finalized head by 1 to 4
  blocks on Monad testnet). If it does not catch up within `INDEXER_HYPERSYNC_CATCH_UP_MS`, or
  HyperSync fails, that batch is read from the RPC and counted in
  `openbalance_indexer_log_batches{source="rpc_fallback",reason}`.
- The client paces itself against the token's `x-ratelimit-*` budget (free plan: 15 queries a
  minute) and waits for the window to reset instead of retrying into 429s.

HyperSync is billed per query, not per block, so backfill uses batches of up to 1,000,000 blocks. On
a fresh database the indexer backfilled the testnet event's 3.9 million blocks in about 18 seconds
(5 batches) and reconciled with no differences. `pnpm hypersync:parity` re-reads the whole history
through HyperSync and compares it, transition by transition, with what the indexer committed. It is
read only.

## Configuration

Configuration is supplied only through the process environment:

```text
INDEXER_DATABASE_URL
INDEXER_RPC_URL
INDEXER_CHAIN_ID
INDEXER_CHAIN_NAME
INDEXER_ENVIRONMENT
INDEXER_EVENT_ID
INDEXER_ROUTER_ADDRESS
INDEXER_LEDGER_ADDRESS
INDEXER_VAULT_ADDRESS
INDEXER_DEPLOYMENT_BLOCK
INDEXER_BATCH_SIZE                 optional, default 500 (1,000,000 with HyperSync)
INDEXER_RPC_LOG_RANGE              optional, default 500, max blocks per eth_getLogs call
INDEXER_POLL_INTERVAL_MS           optional, default 2000 (5000 with HyperSync)
INDEXER_HYPERSYNC_URL              optional, e.g. https://monad-testnet.hypersync.xyz
ENVIO_API_TOKEN                    or INDEXER_HYPERSYNC_TOKEN_PATH (a file); required with the URL
INDEXER_HYPERSYNC_CATCH_UP_MS      optional, default 3000
INDEXER_DATABASE_POOL_SIZE         optional, default 5
INDEXER_PROVISIONAL_ENABLED        optional, default false
INDEXER_PROVISIONAL_REORG_DEPTH    optional, default 128
```

The three contract addresses, event ID, chain ID, and deployment block must come from the verified
deployment manifest. Private RPC and database credentials remain runtime secrets and are never
written to logs.

## Operation

Install the schema once with `pnpm --filter @openbalance/indexer migrate`. The migration runner uses
a PostgreSQL advisory lock and records a source checksum; an already-applied migration whose source
was changed is rejected.

Run locally with `pnpm --filter @openbalance/indexer dev`, or build and start the compiled service.
The service exits on a finalized-history contradiction. RPC/database availability errors are retried
without advancing the cursor.

Provisional observations are opt-in. They are for pending user feedback only and cannot trigger
financial partner writes or replace finalized truth.

Prepare a projection repair with `pnpm --filter @openbalance/indexer rebuild`. Review the emitted
changed-table list, target cursor, source/shadow fingerprints, and plan digest. Promote exactly that
reviewed plan with `pnpm --filter @openbalance/indexer rebuild promote REBUILD_ID PLAN_DIGEST`.
`INDEXER_REBUILD_OPERATOR` is required for attribution. The command never re-emits integration
outbox work, never changes finalized history, and refuses promotion if finalized progress or either
projection copy changed after review.
