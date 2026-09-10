# Verified enrollment to account deployment

Apply migrations `001_enrollment.sql` and `002_account_deployments.sql` in order with a
migration identity. The runtime needs SELECT/INSERT/UPDATE on both tables, without schema privileges.
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
3. Review and submit the returned factory transaction using a gas-paying helper wallet.
4. POST `/v1/accounts/deployments/confirm` with the same token until it reports `confirmed`.

The endpoints accept no caller-supplied owner, recovery key, salt, address, or transaction hash.
They derive the primary key from the verified enrollment, start with no backup or recovery key,
and generate a random salt once under the enrollment's database row lock. The stored parameters
and manifest binding produce the same address and transaction on retries and service restarts.
A changed manifest fails closed instead of silently creating a different account. Recovery setup
remains a separate owner-authorized workflow and should precede funding.

The browser independently reconstructs the transaction from its verified public key and rejects
altered calldata, native value, domain, or chain. A helper wallet pays only deployment gas and
does not become an owner. Automatic gas sponsorship is not implemented in this slice. The UI
retains submission ambiguity and offers a separate Check account action. An explicit retry can
pay gas twice, but the idempotent factory cannot create two accounts for the same parameters.

Confirmation reads actual finalized account state, not a browser-reported transaction hash.
It verifies the fixed clone implementation, initial primary/backup/recovery keys, epoch 1,
factory, RP hash, and origin, and stores the observed block number/hash. It never substitutes
`latest` for an unsupported `finalized` tag. A mined but unfinalized account remains `pending`.
Every confirmation rechecks chain state; an RPC outage never returns an earlier cached success.
Post-recovery ownership is intentionally a mismatch for this initial-deployment verifier, not an
account health assessment. A general authenticated account-status API remains separate work.

The enrollment bearer token permits this flow for 30 minutes after verification and is held
only in browser memory. The database retains parameters afterward; the token does not provide
indefinite access. After a reload or expired token, independent account/address verification
is required; login and recovery of the browser onboarding session are not implemented here.

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
