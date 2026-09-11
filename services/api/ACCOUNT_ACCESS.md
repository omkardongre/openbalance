# Passkey-authenticated account access

Apply `003_account_access.sql` after the enrollment and deployment migrations. Runtime database
access requires SELECT, INSERT, and UPDATE on the two access tables. The service issues a
five-minute, single-use authentication challenge only for an account whose initial deployment has
been verified at a finalized block.

The assertion must use the account's enrolled ES256 credential, configured RP ID and exact origin,
user presence and user verification. The verifier also enforces the restricted authenticator-data
and canonical client-data profile accepted by the account contract. Successful verification updates
the credential counter and returns a 15-minute opaque bearer session. Only its SHA-256 digest is
stored. Sessions have fixed expiry, are held in browser memory, and can be explicitly revoked.

`GET /v1/accounts/me` currently returns only the public account address. It is the authentication
boundary for future activity and command endpoints; it does not claim that current onchain ownership
still matches the initial enrollment after recovery. Those endpoints must verify current ownership
and epoch for every signed command.

No password, email link, API key, or server-held passkey fallback exists. POST requests require the
configured origin, responses are non-cacheable, bodies are bounded, and authorization values are not
logged by the application. Configure TLS, shared edge rate limits, database retention, and log
redaction before a scaled deployment.
