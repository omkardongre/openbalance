# Checkout service

The checkout boundary creates a short-lived, unbound order locator. An attendee authenticates an
already deployed passkey account and binds it to the order. Only then can the registered terminal
sign the resulting payment intent. The attendee independently verifies and approves the same intent.

Required API configuration:

- `DATABASE_URL`: PostgreSQL database with migrations through `008_terminal_order_import`.
- `ACCOUNT_RPC_URL`: HTTPS RPC used for finalized event-policy verification.
- `CHECKOUT_MANIFEST_PATH`: absolute path to the deployed event checkout manifest.
- `CHECKOUT_CAPABILITY_KEY_PATH`: file containing 32 to 64 cryptographically random raw bytes.
- `PROJECTION_READS_ENABLED=true`: enables finalized attendee and operational read-back.

Generate the capability key with a cryptographically secure secret-management workflow and mount it
read-only. Do not encode the key in the manifest, environment, application image, or source control.

The manifest includes the ledger address and runtime bytecode hashes for the registry, ledger,
router, and vault. It is operational configuration, not onchain authority. Before binding an account, the API
reads the finalized router and registry state and rejects any disagreement in chain, contracts, event,
asset, fee version, destination, terminal signer, policy windows, reserve durations, or pause status.

Cashier flow:

1. Authenticate with an event- and vendor-scoped operations credential.
2. Create an idempotent order and share its fragment-only checkout locator.
3. Wait for the attendee to bind their own account.
4. Read the bound intent back from the scoped cashier endpoint.
5. Sign it with the registered terminal wallet and attach the signature.

The capability is hash-only in PostgreSQL and never appears in server logs. Expired locators and
incorrect capabilities return the same not-found response.

Native provisioning uses one-use challenges from `POST /v1/terminal/provisioning-challenges`, then
submits a domain-separated terminal-key signature to `POST /v1/terminal/provisioning` with the same
expiring vendor-scoped credential. Challenges expire after five minutes and are consumed atomically,
so possession of a vendor token alone cannot provision a device. In one transaction the service
pins the current projection cursor and assigns up to 100 untouched
orders to the terminal's offline mode, preventing later attendee binding through the online path.
Retries return the same assigned orders. The response supplies contract pins and candidate channel
IDs; the terminal must independently verify bytecode, bindings, immutable policy, signer, recipients,
and untouched channel state at one finalized RPC block before durable installation.
