# Service execution

Build from the repository root:

```sh
docker build -f deploy/Dockerfile.services -t openbalance-services .
```

Choose `OPENBALANCE_PROCESS`: `api`, `relayer`, `financial-worker`, `indexer`,
`integrations`, or `venue-relay`. Each runs as the unprivileged `node` user and
executes the built service directly, so termination signals reach its shutdown handler.
Configure each container independently using that service's documented environment.
Mount manifests and secret files read-only; inject only the credentials that process needs.
The venue relay additionally needs a persistent writable journal directory owned by UID 1000.
Do not expose its ingress without the configured terminal authentication and TLS boundary.

Migration processes are `migrate-indexer`, `migrate-api`, `migrate-relayer`, and
`migrate-integrations`, in that order. Run them as separate one-shot jobs with migration
credentials before service startup. Normal service startup does not apply migrations.
Use restricted runtime database identities afterward. Container build does not require
database, RPC, signing, or partner credentials. Runtime configuration errors fail startup.

The image currently includes the locked build dependencies. The Node base is pinned by
digest; review/image-scan and record the final application image digest before publishing.
Deploy long-running financial, indexer, integration, and venue workers on continuously
running hosts; request-only CPU allocation does not satisfy their polling requirements.

## Repeatable database verification

```sh
pnpm verify:postgres
```

Requires the pinned Node/pnpm toolchain and a running Docker daemon. The command creates a
uniquely named PostgreSQL 16 container with a random password and an ephemeral loopback port,
applies all four migration sets twice, then runs indexer, API and integration tests against it.
It does not read a configured application database URL. The disposable container and its
anonymous data volume are removed afterward. No partner or chain access is required for
the database suite; tests requiring a deployment RPC remain separately gated.

This verifies local migration and persistence behavior. It does not establish testnet,
partner-system, managed identity, or physical-device correctness.

## Payment measurement reports

`node scripts/payment-metrics.mjs observations.json` summarizes a bounded measurement run.
The file contains `environment`, `chainId`, `contractCodeHash`, `startedAtMs`, `endedAtMs`, and
`payments`. Each payment has a unique `paymentId`, `offeredAtMs`, and `status` (`FINALIZED`,
`REVERTED`, `REJECTED`, or `PENDING`). Finalized or reverted transactions additionally require
`finalizedAtMs`, `transactionHash`, `blockHash`, and decimal strings for `blockNumber`, `gasUsed`,
and `effectiveGasPriceWei`. Finalized times refer to observed canonical finality, not first mining.

Retain every offered payment, including failures and unresolved attempts. Repeated network
submission of one payment is one offered payment; record retry details in a separate trace.
The report includes offered/finalized rates over the complete measurement interval, success
fraction over all offers, nearest-rank latency percentiles for successes, exact confirmed gas
cost including reverted transactions, and explicitly unknown pending cost. It validates input
consistency but does not authenticate supplied chain references. Independently verify those
references and retain the raw observations and workload methodology with published results.
Run `pnpm test:tooling` for the focused accounting and malformed-evidence checks.
