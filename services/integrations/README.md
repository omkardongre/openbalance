# OpenBalance partner adapters

This package contains narrow server-side clients for pretix admission context and ERPNext finalized
payment accounting. It does not hold signing authority or accept browser-supplied partner scope.

- The pretix client is constructed with one organizer and event, fetches one exact order, and returns
  only payment state, test-mode status, active position IDs, and the upstream modification time.
- The ERPNext client sends one finalized transition to a dedicated Frappe method using the transition
  ID as its idempotency key. It then performs a separate GET and rejects any scope, amount, chain,
  transaction, document-status, or document-identity mismatch.
- HTTP transport rejects redirects, cross-origin requests, non-JSON responses, oversized bodies, and
  credential-bearing base URLs. Partner errors never imply a successful payment or accounting write.
- The finalized-payment importer reads only finalized online projections, requires an exact ready
  checkout-order mapping and approved stream/event/vendor mapping, then enqueues the immutable
  transition. Its durable ordered cursor advances only after the idempotent job exists.
- Delivery uses fenced PostgreSQL leases, bounded retry, terminal quarantine, and an immutable attempt
  history. A timeout is retried with the same transition identity; it never creates a new payment.

The ERPNext installation must provide `openbalance.api.record_finalized_payment` as a narrowly
permissioned method. POST creates or reuses submitted Sales Invoice and Payment Entry records under a
database uniqueness constraint on `transition_id`; GET returns the stored record. Credentials belong
in the integration worker's secret store and must never be exposed to the web application.

## Worker process

Apply `INTEGRATION_DATABASE_URL` with `pnpm --filter @openbalance/integrations migrate`, then run
the compiled worker with separate `INDEXER_DATABASE_URL`, `API_DATABASE_URL`, and
`INTEGRATION_DATABASE_URL` connections. `INTEGRATION_MAPPING_PATH` points to a strict JSON document
containing `schemaVersion: 1` and approved stream/event/vendor mappings with `company` and
`assetCode`. ERPNext base URL, method, key, and secret are injected at runtime. The process verifies
all three schemas before polling, imports finalized ready checkout orders in canonical order, and
drains a bounded number of retry-safe writes per cycle. It exits on a missing mapping instead of
silently omitting a vendor.
