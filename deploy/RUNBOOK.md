# OpenBalance operations runbook

Operational reference for deploying and running the OpenBalance services. It records the runtime
entrypoints, the configuration each service validates, the health surfaces, and the response for
each alert in `deploy/observability/alert-rules.yaml`.

## Service inventory

| Service | Entrypoint | Process | Surfaces |
| --- | --- | --- | --- |
| API | `services/api/dist/server.js` | request | `GET /health/live`, `GET /health/ready` |
| Relayer | `services/relayer/dist/server.js` | request | `GET /health/live`, `GET /health/ready` |
| Web | `apps/web` (Next.js standalone) | request | `/` |
| Venue relay | `services/venue-relay/dist/server.js` | request | `GET /health`, `/metrics` |
| Financial worker | `services/relayer/dist/financial-worker-server.js` | worker | `/metrics` |
| Venue-relay settlement worker | `services/venue-relay/dist/settlement-worker-server.js` | worker | `/metrics` |
| Indexer | `services/indexer/dist/server.js` | worker | `/metrics` |
| Integrations worker | `services/integrations/dist/server.js` | worker | `/metrics` |

Container entrypoints are selected with `OPENBALANCE_PROCESS`:
`server`, `settlement-worker`, `financial-worker`, `migrate` (per-service image via
`deploy/run-service.sh`) or `api`, `indexer`, `integrations`, `relayer`, `venue-relay`,
`venue-relay-settlement`, `financial-worker`, `migrate-<service>` (monorepo image via
`deploy/service-entrypoint.sh`).

## Configuration and secret bindings

Each service validates its own environment strictly and refuses to start on missing or malformed
values. Only the variables a service declares may be injected.

- **API** (`services/api/src/config.ts`): `DATABASE_URL`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`,
  `ACCOUNT_MANIFEST_PATH`, `ACCOUNT_RPC_URL`, `PROJECTION_READS_ENABLED`,
  `CHECKOUT_MANIFEST_PATH`, `CHECKOUT_CAPABILITY_KEY_PATH`.
- **Relayer** (`services/relayer/src/config.ts`): `DATABASE_URL`, `WEBAUTHN_*`, `ACCOUNT_*`,
  `SPONSOR_PRIVATE_KEY_PATH`, sponsorship budgets, `FINANCIAL_EVENT_MANIFEST_PATH`.
- **Financial worker**: `DATABASE_URL`, `FINANCIAL_EVENT_MANIFEST_PATH`, `FINANCIAL_RPC_URL`,
  `FINANCIAL_CHAIN_NAME`, `FINANCIAL_SIGNER_PRIVATE_KEY_PATH`, `FINANCIAL_WORKER_ID`,
  `FINANCIAL_MAX_GAS`, `FINANCIAL_MAX_FEE_PER_GAS_WEI`, `FINANCIAL_MAX_COST_WEI`.
- **Venue relay**: `VENUE_RELAY_DATABASE_PATH`, `VENUE_RELAY_KEY_PATH`, `TERMINAL_SNAPSHOT_PATH`,
  `TERMINAL_INGRESS_AUDIENCE`, `TERMINAL_MAXIMUM_CLOCK_SKEW_SECONDS`.
- **Venue-relay settlement worker**: `VENUE_RELAY_DATABASE_PATH`, `VENUE_RELAY_KEY_PATH`,
  `VENUE_RELAY_RPC_URL`, `VENUE_RELAY_CHAIN_ID`, `VENUE_RELAY_CHAIN_NAME`,
  `VENUE_RELAY_VAULT_ADDRESS`, `VENUE_RELAY_DEPLOYMENT_BLOCK`, `VENUE_RELAY_FINALITY_TAG`,
  `VENUE_RELAY_SETTLEMENT_PRIVATE_KEY_PATH`, `VENUE_RELAY_SETTLEMENT_WORKER_ID`.
- **Indexer**: `INDEXER_DATABASE_URL`, `INDEXER_RPC_URL`, `INDEXER_CHAIN_ID`, `INDEXER_CHAIN_NAME`,
  `INDEXER_EVENT_ID`, `INDEXER_ROUTER_ADDRESS`, `INDEXER_LEDGER_ADDRESS`, `INDEXER_VAULT_ADDRESS`,
  `INDEXER_DEPLOYMENT_BLOCK`, `INDEXER_ENVIRONMENT`.
- **Integrations worker**: `INTEGRATION_DATABASE_URL` plus the pretix and ERPNext scoped
  credentials and mapping path.

Secret Manager secrets created by Terraform: `account-manifest`, `event-manifest`,
`checkout-capability`, `integration-mapping`, `relayer-signer`, `venue-relay-key`,
`venue-relay-settlement-signer`, `terminal-snapshot`. Mount each as a file and point the matching
`*_PATH` variable at it; never inject key material as a plain value.

`VENUE_RELAY_FINALITY_TAG` must be `finalized` on public networks. Local development chains that
report `finalized` as genesis (for example Anvil) must use `latest`, which weakens the settlement
confirmation policy and must never be used for real funds.

## Health and readiness

- Request services expose `GET /health/live` and `GET /health/ready`; `ready` returns `503` when a
  dependency probe fails. Use `live` for liveness and `ready` for readiness/rollout gates.
- The venue relay exposes `GET /health`.
- Workers expose Prometheus metrics on `METRICS_PORT` (`/metrics`); use an HTTP probe on `/metrics`
  as the liveness check and alert on `up == 0`.

## Startup order

1. Apply infrastructure and provision secrets; run database migrations
   (`migrate-api`, `migrate-indexer`, `migrate-relayer`, `migrate-integrations`).
2. Start the API, relayer and venue relay request services.
3. Start the indexer, integrations, financial and venue-relay settlement workers.
4. Confirm `/health/ready` on the API and relayer, and `up == 1` for every worker before routing
   traffic.

## Alert response

### Service down
Check `up`, then the service's own `/health/ready` or `/metrics`. A failing dependency probe names
the dependency in the response body. Do not restart a worker that reports a reconciliation
difference before reading that incident.

### Server error rate
Inspect `openbalance_http_requests` by `route` and `status`. `5xx` on `/v1/vouchers` with
`voucher_conflict` is expected for genuine conflicts; investigate only sustained unexplained
errors. Trace by `X-Request-Id`.

### Latency
High `openbalance_http_duration` usually indicates RPC or database contention. Confirm the
database and RPC are healthy before scaling; scaling will not fix a saturated dependency.

### Voucher quarantined
A voucher receipt was permanently rejected. Read the quarantined receipt in the relay journal,
confirm the terminal signature, sequence and `submitUntil`, and record the unpaid exception. The
attendee's unused reserve still returns by the fixed deadline; never edit a settled record.

### Financial quarantined
A relayer command was permanently rejected. Confirm the account manifest, policy budget and
on-chain state, then re-authorize from the user rather than resubmitting a changed command.

### Reconciliation difference
Stop dependent external writes. Rebuild the finalized projection into a shadow schema, compare
custody and liabilities, and promote only after the difference is explained. Never delete partner
records to make totals match.

### Integration delivery
Confirm the partner instance is reachable and the mapping is current, then let the durable journal
retry. A destination response without read-back stays `ACKNOWLEDGED_UNVERIFIED`.

### Indexer stalled
Confirm the RPC head is advancing and the cursor is committed. A contradiction involving
previously finalized history is an integrity incident: halt external writes until resolved.

## Rollback

Deployments are immutable per release. Roll back by redeploying the previous image tag; contracts
and their verifier addresses are never changed underneath funded state. A new contract release is
a new deployment that routes only new consent.
