# Operational access

Operational reporting is served from finalized PostgreSQL projections. It never infers finality
from pending relayer state. Access tokens are random 256-bit credentials stored only as SHA-256
hashes and scoped to one exact indexer stream and event. Vendor credentials additionally bind one
vendor identifier.

Apply the indexer migration first, then the API migrations, before enabling projection reads:

```bash
pnpm --filter @openbalance/indexer migrate
pnpm --filter @openbalance/api migrate
```

Run the API with `PROJECTION_READS_ENABLED=true` and the same `DATABASE_URL` used by the finalized
indexer projections. Existing enrollment configuration remains required because attendee projection
reads stay passkey-protected.

Provision credentials from a trusted administrative shell with `DATABASE_URL`,
`OPERATIONS_PRINCIPAL_ID`, `OPERATIONS_ROLE`, `OPERATIONS_STREAM_ID`, `OPERATIONS_EVENT_ID`, and
`OPERATIONS_CREDENTIAL_TTL_HOURS`. Set `OPERATIONS_VENDOR_ID` only for `VENDOR`; it is required for
that role and rejected for every other role. The command prints the credential once; place it
directly into the intended secret manager and do not retain it in shell history or application
configuration files.

```bash
pnpm --filter @openbalance/api provision:operations-access
```

The API exposes:

- `GET /v1/operations/me`
- `GET /v1/events/{eventId}/statements?vendorId=...`
- `GET /v1/events/{eventId}/reconciliation`
- `GET /v1/events/{eventId}/incidents`
- `POST /v1/incidents`
- `POST /v1/incidents/{incidentId}/resolutions`

`VENDOR` can read only its bound statement and incidents and can open incidents only for that
vendor. `ORGANIZER` and `FINANCE` can read statements and reconciliation. Every role can open and
list event incidents; only `ORGANIZER` and `SUPPORT` can resolve them. None of these credentials can
sign a payment, refund, withdrawal, reserve, or reclaim.

Statement totals become `COMPLETE` only for the full finalized range when every payment allocation
has been verified and an approved beneficiary mapping exists. A partial range is `PERIOD_ONLY`;
offline allocations awaiting deterministic read-back remain `READBACK_REQUIRED`. Reconciliation
reports `STALE` when its last successful run does not cover the current finalized cursor.

Incident creation and resolution are idempotent, event-scoped, and append an audit action. Resolving
an incident does not alter any payment, refund, withdrawal, reserve, or integrity record.
