# openbalance

Application source for OpenBalance: contracts, API, relayer, indexer, venue relay, web, and Android
terminal. Product context and the full specification live in the workspace root
[`../README.md`](../README.md) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md); this file documents
only what exists in this repository and how to run it.

## Status

Contract, protocol, API, relayer, indexer, venue relay, terminal, and web packages are implemented
and locally tested (`pnpm check`, `pnpm test`). The account and event contract set is deployed and
verified on Monad testnet. Services (API, relayer, indexer, venue relay, web) are not yet deployed
against that testnet manifest.

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

Runtime secret material is delivered as files mounted at `/run/secrets/<name>` (mode 0400), matching
the file paths the services already accept; each identity is granted access only to the secrets its
own process needs. `DATABASE_URL` stays an environment value because the runtime reads it that way.

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
