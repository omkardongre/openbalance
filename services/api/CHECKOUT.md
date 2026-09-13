# Checkout service

The checkout boundary creates a short-lived, unbound order locator. An attendee authenticates an
already deployed passkey account and binds it to the order. Only then can the registered terminal
sign the resulting payment intent. The attendee independently verifies and approves the same intent.

Required API configuration:

- `DATABASE_URL`: PostgreSQL database with migrations through `006_checkout_orders`.
- `ACCOUNT_RPC_URL`: HTTPS RPC used for finalized event-policy verification.
- `CHECKOUT_MANIFEST_PATH`: absolute path to the deployed event checkout manifest.
- `CHECKOUT_CAPABILITY_KEY_PATH`: file containing 32 to 64 cryptographically random raw bytes.
- `PROJECTION_READS_ENABLED=true`: enables finalized attendee and operational read-back.

Generate the capability key with a cryptographically secure secret-management workflow and mount it
read-only. Do not encode the key in the manifest, environment, application image, or source control.

The manifest is operational configuration, not onchain authority. Before binding an account, the API
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
