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

For smaller single-service images, build `deploy/Dockerfile.service` with a required service:

```sh
docker build -f deploy/Dockerfile.service --build-arg SERVICE=api -t openbalance-api .
docker build -f deploy/Dockerfile.service --build-arg SERVICE=relayer --build-arg PROCESS=financial-worker -t openbalance-financial-worker .
```

Supported service values are `api`, `relayer`, `indexer`, `integrations`, and `venue-relay`.
Set `PROCESS=migrate` for the four services with migrations. The deploy stage contains only that
package's declared runtime files and production dependency closure. The shared image remains useful
for local operations, but is not the release default.

Build `deploy/Dockerfile.web` separately for the public interface. It copies only the Next.js
standalone server, static assets, and public assets into its runtime stage.
Supply `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_RELAYER_URL`, `NEXT_PUBLIC_FINANCIAL_RPC_URL`,
`NEXT_PUBLIC_WEBAUTHN_RP_ID`, `NEXT_PUBLIC_TERMINAL_RELAY_URL` (the relayer's deterministic Cloud Run
origin, e.g. `https://openbalance-testnet-relayer-<number>.<region>.run.app`; terminal setup codes
carry it with `/v1/vouchers`, which the web adds itself) and `NEXT_PUBLIC_SETTLEMENT_ASSET` (the event's settlement token, read
for the balance on `/account`) as public build arguments for a configured release. Never use private
RPC credentials in these browser-visible values. An image built without them is a build check only.

The Node base is pinned by digest; review/image-scan and record the final application image digest before publishing.
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

## Workload and evidence

`pnpm workload -- workload.json observations.json` sends pre-built, uniquely identified payment
offers at 10, 50, or 100 requests per second and retains rejected, reverted, pending, and finalized
outcomes. Credentials are read only from the environment variable named in the workload manifest;
they are never written to the observation file. A finalized/reverted result is accepted only with
transaction, block, gas, and finality evidence returned by the status endpoint.

Run the measurement aggregator against the raw output, then list both raw and summarized artifacts
in a versioned evidence manifest. `pnpm evidence:package -- manifest.json evidence/run-id` validates
paths, checksums every input, rejects credential-shaped fields and private-key PEM material, and
creates a non-overwriting index. This packaging validates integrity of local files; it does not
authenticate chain or partner claims by itself.

`pnpm run sbom` emits a deterministic CycloneDX inventory of lockfile dependencies, including build
dependencies; it is not a runtime-only image inventory. CI separately scans each built image.
`pnpm coverage:contracts` uses minimal IR to compile the cryptographic library; source-map coverage
has that tooling limitation and is not an audit result.
