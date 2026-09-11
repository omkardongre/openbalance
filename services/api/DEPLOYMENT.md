# Verified enrollment to account deployment

Apply migrations `001_enrollment.sql` through `004_deployment_sponsorship.sql` in order with a
migration identity. The runtime needs SELECT/INSERT/UPDATE on the runtime tables, without schema
privileges.
Configure `ACCOUNT_MANIFEST_PATH` and `ACCOUNT_RPC_URL` together with the enrollment variables.
Without the deployment pair, enrollment works but deployment routes are absent. Partial configuration,
missing tables, an incorrect chain, or mismatched factory/implementation code prevents startup.

## Factory and deployment record

Build contracts and the protocol package, then use `apps/web/scripts/deploy-account-factory.mjs`.
The `deploy` operation uses `ACCOUNT_WALLET_RPC_URL` and `ACCOUNT_DEPLOYER_ADDRESS` to request
a transaction from an operator-controlled wallet RPC. `ACCOUNT_RPC_URL` supplies read access.
Only local chain 31337 and Monad testnet 10143 are enabled. The script accepts no private keys.

After the factory is finalized, run `manifest FACTORY_ADDRESS` to print a JSON account manifest.
Save its public output to the configured manifest file. It records chain, factory, implementation,
and both bytecode hashes. Manifest extraction records observed code; it does not establish that an
unknown factory is trusted. Use the factory deployed from the reviewed build and verify its source.
Keep compiler/artifact provenance with the deployment record. A mined factory is not automatically
finalized; if manifest extraction fails, retry that read, not the deployment transaction.

## Account flow

1. Complete registration and the separate key-possession proof.
2. POST `/v1/accounts/deployments/prepare` with `{ "token": "ENROLLMENT_TOKEN" }`.
3. Request bounded sponsorship, or review and submit the transaction using a gas-paying wallet.
4. POST `/v1/accounts/deployments/confirm` with the same token until it reports `confirmed`.

The endpoints accept no caller-supplied owner, recovery key, salt, address, or transaction hash.
They derive the primary key from the verified enrollment, start with no backup or recovery key,
and generate a random salt once under the enrollment's database row lock. The stored parameters
and manifest binding produce the same address and transaction on retries and service restarts.
A changed manifest fails closed instead of silently creating a different account. Recovery setup
remains a separate owner-authorized workflow and should precede funding.

The browser independently reconstructs a manual transaction from its verified public key and rejects
altered calldata, native value, domain, or chain. A helper wallet pays only deployment gas and
does not become an owner. The primary browser action requests bounded gas sponsorship; permissionless
wallet submission remains an explicit alternate path. The UI retains submission ambiguity and offers
a separate Check account action. An explicit manual retry can
pay gas twice, but the idempotent factory cannot create two accounts for the same parameters.

Confirmation reads actual finalized account state, not a browser-reported transaction hash.
It verifies the fixed clone implementation, initial primary/backup/recovery keys, epoch 1,
factory, RP hash, and origin, and stores the observed block number/hash. It never substitutes
`latest` for an unsupported `finalized` tag. A mined but unfinalized account remains `pending`.
Every confirmation rechecks chain state; an RPC outage never returns an earlier cached success.
Post-recovery ownership is intentionally a mismatch for this initial-deployment verifier, not an
account health assessment.

## Bounded sponsorship

Set every sponsorship variable or none: `SPONSOR_PRIVATE_KEY_PATH`,
`SPONSOR_DAILY_DEPLOYMENTS`, `SPONSOR_MAX_DEPLOYMENT_GAS`,
`SPONSOR_MAX_FEE_PER_GAS_WEI`, and `SPONSOR_MAX_COST_WEI`. The key path must be a regular,
non-symlink file inaccessible to group and other users. Mount it from a managed secret; never place a
private key in an environment variable, image, repository, command line, or log. The sponsor address
must be funded only with the bounded operational gas budget.

These variables and the signing key belong only to the separately started `@openbalance/relayer`
service. The consumer API process never loads the key. Route the sponsorship endpoint to that
service through deployment ingress and set `NEXT_PUBLIC_RELAYER_URL` to its public origin for the
browser build. Keep API and relayer runtime identities, secret access, and deployment permissions
separate.

`POST /v1/accounts/deployments/sponsor` requires the verified enrollment token and an
`Idempotency-Key`. The caller cannot provide a destination, calldata, value, owner, nonce, gas, or fee.
The service reconstructs the exact configured factory `create` call, simulates gas, applies gas, fee,
and total-cost ceilings, and enforces the UTC daily deployment quota under a PostgreSQL advisory lock.
It reserves a signer nonce and stores the signed transaction and expected hash before broadcasting.
Retries either read finalized account state, observe the same transaction, or rebroadcast the exact
stored bytes. A changed idempotency key conflicts; it never creates another sponsored account.

The stored signed transaction is public-chain material but can be rebroadcast until mined, so restrict
database access and retention. A reverted transaction is recorded and never reported as successful.
RPC failure leaves a durable signed or submitted state for retry; it does not fall back to arbitrary
wallet calls or cached confirmation. Dedicate the signer to this service because its nonce coordinator
cannot account for transactions produced elsewhere. Horizontally scaled instances must share the same
PostgreSQL database and signer policy.

The enrollment bearer token permits deployment for 30 minutes after verification and is held
only in browser memory. The database retains parameters afterward; the token does not provide
indefinite access. After a reload or expired token, independent account/address verification
is required. Passkey login and revocable sessions are documented in `ACCOUNT_ACCESS.md`.

## Local evidence and remaining proof

Run tests with `ENROLLMENT_TEST_DATABASE_URL` for a disposable PostgreSQL database and
`DEPLOYMENT_TEST_RPC_URL=http://127.0.0.1:8545` for local Anvil. Build the Foundry artifacts first.
The integration test requires chain 31337, uses generated registration/assertion signatures,
deploys the real factory/account, mines local blocks to exercise finality, and verifies concurrent
retry, restart, token isolation, key binding, and manifest/chain/code rejection. No public network
is written by the test. Without those variables, integration tests are explicitly skipped.

The browser page and API compile; real device/browser wallet interaction and Monad testnet
finality support remain unproven. This account-deployment manifest is scoped to ownership:
asset, event, settlement, and other full-product manifest fields await their implementations.
