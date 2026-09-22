# openbalance

Application source for OpenBalance: contracts, API, relayer, indexer, venue relay, web, and Android
terminal. Product context and the full specification live in the workspace root
[`../README.md`](../README.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md); this file documents
only what exists in this repository and how to run it.

## Status

Contract, protocol, API, relayer, indexer, venue relay, terminal, and web packages are implemented
and locally tested (`pnpm check`, `pnpm test`). The account and event contract set is deployed and
verified on Monad testnet. The API, relayer, indexer, financial worker and web app run against that
manifest on the testnet project, and the attendee journey — passkey enrollment, sponsored account
deployment, sign-in, test funding, reserve channel, voucher settlement, reclaim, refund and vendor
withdrawal — is proven against those deployed services on chain. The venue relay and the integration
worker are not deployed; see the root checklist for why each is withheld rather than pending.

## Layout

```text
contracts/          Solidity sources, Foundry config and tests
packages/
  protocol/         Shared typed encoding, boundary validation, ABI
  verifier/         Independent finalized-state / deployment-binding verifier core
  attendee/         Attendee offline wallet (device key, QR codec, authorization state machine)
  terminal/         Venue terminal core (journal, QR codec, time-confidence policy)
  sdk/              Typed TypeScript SDK over the API
  mcp/              MCP server exposing the SDK as tools over stdio JSON-RPC
  scenario/         Deterministic virtual-WebAuthn authenticator and process-level scenarios
  observability/    OpenTelemetry setup shared by the services
services/
  api/              Fastify payment API: intents, identity, consent, migrations
  relayer/          Sponsored command signing, financial worker, vendor treasury actions
  indexer/          Finalized-log indexing, PostgreSQL projections, reconciliation
  venue-relay/      Independent local process retaining and forwarding signed receipts
  integrations/     pretix and ERPNext adapters
apps/
  web/              Next.js attendee, cashier, organizer, finance and support flows
  terminal-android/ Kotlin Android terminal application
scripts/            Deployment, verification, workload, evidence and tooling scripts
deployments/        Bytecode-bound deployment manifests (per environment)
infra/              Terraform templates for the cloud deployment
contract/           OpenAPI 3.1 contract and generated types
```

## Requirements

- Node.js `>=24.21.0 <25`, pnpm `>=12.3.4 <13` (pinned in `package.json#engines`)
- Foundry (`forge`, `cast`) — resolved through `scripts/foundry-bin.mjs` rather than bare `forge`,
  because some environments have a same-named binary earlier on `PATH`
- Docker, for the disposable PostgreSQL used by `verify:postgres` and the system harness

## Common commands

```bash
pnpm install
pnpm check          # Biome, per-package checks, forge fmt --check
pnpm test           # tooling tests, per-package tests, forge test
pnpm build          # turbo build + forge build
pnpm verify:release # check + test + build + contract coverage + SBOM
```

Local verification and scenarios (each boots what it needs against a disposable database and/or a
local Anvil chain):

```bash
pnpm verify:postgres     # disposable PostgreSQL 16, migrations and focused integration paths
pnpm verify:scenario     # account ownership + offline reserve scenario against live Anvil
pnpm verify:relay        # venue relay + settlement worker process-level scenario
pnpm verify:faucet       # test-funding faucet scenario against a live chain and PostgreSQL
pnpm verify:system       # full concurrent harness: PostgreSQL, Anvil, API, relayer, indexer, venue relay
pnpm workload:slo        # SLO-thresholded smoke/load/stress workload runner
pnpm evidence:local      # checksummed local evidence bundle over the above
```

## Testnet deployment

`.env.testnet.example` documents every variable `scripts/deploy-testnet.mjs` needs; copy it to
`.env.testnet` (gitignored) and fill in real values. Signing uses an encrypted Foundry keystore plus
a password file under the gitignored `secrets/` tree — never a plaintext private key.

```bash
pnpm testnet:preflight   # read-only: chain, signer funding, settlement asset checks
pnpm testnet:deploy      # resumable; adopts an existing event rather than re-deploying it
pnpm testnet:manifest    # emits deployments/testnet/*.json from a read at the finalized block
pnpm testnet:verify      # publishes source to the explorer for every deployed contract
```

All four commands are idempotent: re-running `deploy` does not redeploy, and `verify` treats an
already-verified contract as success. `deployments/testnet/` holds the account manifest, the
relayer's routing manifest, and the verifier manifest, each binding an address to the hash of the
bytecode actually running there at a finalized block. `pnpm verify:remote-config` checks that the
configured database and both RPC providers are reachable and serve the intended chain before any of
the above runs against them.

### Event provisioning

```bash
pnpm testnet:provision-event   # organizer policy: config version, vendor, payout destination, terminal
```

No money can move before these four records exist, and all four are `onlyOrganizer` writes, so the
script signs them with the organizer's encrypted keystore and never with a key taken from the
environment. It reads each slot before writing it because the registry rejects a second write with
`AlreadyExists`: a re-run must skip, since registering a *new* version instead would silently diverge
from the version the services were configured to use. Every record is read back from the registry
afterwards — a provisioning run that reported success without confirming the chain's own view would be
asserting intent rather than state. The vendor authority and terminal signer are operational signing
keys that later steps sign with directly, so they are written to the gitignored `secrets/` tree at mode
0600; the organizer key is not one of them and stays encrypted. Public identifiers land in
`deployments/testnet/event-provisioning.json`.

### Driving the journey against deployed services

The scenario package doubles as the driver for a deployed environment. `SCENARIO_KIND=api-enroll`
enrolls a passkey and deploys the account, `api-fund` signs in and takes a faucet grant in a separate
process, and `treasury` runs the money operations; the first writes a state file the others restore, so
the journey survives a restart between steps. Two settings only matter against a public chain:

- `SCENARIO_CREDENTIAL_ID` — the virtual authenticator otherwise derives its credential identifier
  from the relying-party identifier, which is reproducible locally but re-presents an already
  registered credential against a persistent database.
- `SCENARIO_TIME_CONTROL=chain` — acceptance and submission windows are evaluated against
  `block.timestamp`, and a public network offers no `evm_increaseTime`, so deadlines are waited out in
  real time. Set `SCENARIO_WINDOWS` as short as the registered `maximumAcceptanceDuration` and
  `maximumSubmissionDelay` permit, since the wait is the real thing.

`SCENARIO_PROVISIONED` supplies the registry records from the provisioning step instead of registering
new ones, which also keeps the harness from holding the organizer's key. Money operations are polled to
`FINALIZED` rather than trusted at the relayer's `202`: acceptance is a queued operation, and the
withdrawal pays out the vendor's whole remaining credit, so a refund drawing on that credit has to have
executed first.

### Release images

```bash
pnpm images:publish                 # all service and worker images
pnpm images:publish api relayer     # a named subset
pnpm images:publish web             # only after the request-service URLs are known
```

Each image is pushed, then its digest is read back from the registry and written into
`infra/terraform/testnet.tfvars` as `image@sha256:...`. Deployments reference digests, never tags,
because a tag names whichever bytes it currently points at, so a re-push or rollback would change
what a running service executes. The repository sets immutable tags and a keep-before-delete cleanup
policy so a released tag cannot be repointed and a digest a rollback still needs is not collected.

`web` is built separately and last. Its `NEXT_PUBLIC_*` values are compiled into browser bundles at
build time and are the deployed API/relayer URLs, so the script refuses to build it without them
rather than producing an image that looks releasable and cannot work.

Use the *deterministic* hostname, `<service>-<project number>.<region>.run.app`, not the URI the
service resource reports. Cloud Run serves both that form and a hashed one, but only one of them can
be the WebAuthn origin, and the API and relayer are told that origin before the web service exists —
so a bundle built against the hashed hostname yields passkey failures that read as code defects.
`terraform output configured_web_origin` is the authoritative value; confirm it serves before
building, because the build bakes it in irreversibly.

`NEXT_PUBLIC_FINANCIAL_RPC_URL` must be a public RPC. Everything `NEXT_PUBLIC_*` ships to the browser,
so passing the operational provider's authenticated endpoint would publish its key to every visitor.
The verifier is designed around a caller-selected public RPC for exactly this reason. Grep the built
bundle for provider hostnames afterwards; intent is not evidence.

Runtime secret material is delivered as files at `/run/secrets/<name>/<name>` (mode 0400), matching
the file paths the services already accept; each identity is granted access only to the secrets its
own process needs. `DATABASE_URL` stays an environment value because the runtime reads it that way.

The repeated name is not redundant. Cloud Run presents a secret volume as a *directory* whose file is
named by the item path, so the mount path itself is a directory and opening it fails with `EISDIR`.
The worker VMs write their fetched secrets into the same per-secret subdirectory even though nothing
forces them to, so one path convention holds on both runtimes and the identical container image needs
no knowledge of which one it is running on. Paths are derived from a single Terraform local rather
than written out per service, because a path that is correct in eleven places and wrong in the twelfth
fails only for the one process that reads it, at startup, in whichever environment it reaches first.

Worker VMs differ from Cloud Run in two ways that are easy to miss because Cloud Run needs neither.
They pull their own image under their instance identity, so each worker identity holds read-only
Artifact Registry access on that one repository; Cloud Run's pull is performed by the platform's
service agent instead. They also run the Container-Optimized OS logging and monitoring agents as
themselves, so they hold `logging.logWriter` and `monitoring.metricWriter` — without which a crashed
worker is invisible, since a VM that boots but never starts its container still reports `RUNNING` and
still leaves its instance group reporting stable.

`scripts/probe-precompile-testnet.mjs` is a one-time platform-conformance check, not part of the
deploy flow: it confirms the account's WebAuthn verification actually reaches Monad's native P256
precompile at `0x0100` rather than silently using OpenZeppelin's Solidity fallback, by deploying a
throwaway probe contract whose `verifyNative` reverts if the precompile is absent. Requires
`--via-ir` to compile, which the production contracts do not need.

## Notes

- `forge` is not a unique binary name in every environment; `scripts/foundry-bin.mjs` resolves it by
  reading each candidate's own `--version` banner rather than trusting `PATH` order, and the package
  scripts call it through `scripts/foundry.mjs` so they cannot pick up a shadowing binary either.
- Confirmed on testnet: the account's WebAuthn verification reaches the native P256 precompile, not
  the Solidity fallback (see Testnet deployment above).
- Sponsored throughput is bounded per signing key by the chain's per-account inflight gas budget, so
  capacity comes from adding keys via `FINANCIAL_SIGNER_ADDITIONAL_KEY_PATHS`, not from raising a
  limit. The worker rations against that budget before signing because an over-budget transaction is
  excluded by consensus rather than reverted, which is silent at the point of broadcast. Set
  `FINANCIAL_RESERVE_BALANCE_WEI=0` on development chains that do not implement the rule.
- `FINANCIAL_GAS_LIMIT_MARGIN_BPS` stays small (default 10%) because gas is charged on the declared
  limit with no refund, so margin is both permanent overspend and inflight budget that admits no
  other transaction.
- `pnpm verify:system` covers financial *intake* only; it does not start the financial worker, so the
  signing and broadcast path has no process-level coverage in that harness.
