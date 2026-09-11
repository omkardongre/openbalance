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
INDEXER_BATCH_SIZE                 optional, default 500
INDEXER_POLL_INTERVAL_MS           optional, default 2000
INDEXER_DATABASE_POOL_SIZE         optional, default 5
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

The current implementation indexes finalized state only. Subscriptions and provisional projections
remain a latency enhancement; they cannot trigger financial partner writes or replace finalized
truth.
