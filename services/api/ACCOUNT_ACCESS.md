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

`GET /v1/accounts/me` returns only the public account address. The same session protects finalized
payment, reserve-channel, and paginated account-activity reads. Every projection query includes the
authenticated account in its database predicate; a missing record and a record owned by another
account produce the same response. Financial responses are non-cacheable and expose transaction,
block, and finalized-cursor proof references without returning signatures or private receipt data.

Operational reads require the finalized indexer migration in the same PostgreSQL database and are
enabled explicitly with `PROJECTION_READS_ENABLED=true`. The API checks those projection tables at
startup. Payment responses distinguish cancellation, finalization,
partial refund, and full refund. Channel responses report exact reserve conservation and the latest
finalized channel transition. Activity uses a stable `(blockNumber, transitionId)` cursor and caps a
page at 100 records.

The authenticated address is the initial verified deployment identity; it does not by itself prove
that current onchain ownership still matches after recovery. Future command endpoints must verify
current ownership and epoch for every signed command.

No password, email link, API key, or server-held passkey fallback exists. POST requests require the
configured origin, responses are non-cacheable, bodies are bounded, and authorization values are not
logged by the application. Configure TLS, shared edge rate limits, database retention, and log
redaction before a scaled deployment.
