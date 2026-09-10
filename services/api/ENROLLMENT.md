# Passkey enrollment

The `/enroll` web route creates an ES256 resident credential, then asks the same credential to
sign a fresh challenge. The service validates registration and proof with SimpleWebAuthn,
extracts P256 coordinates from the verified COSE key, and checks that the assertion matches
the account's strict JSON/authenticator-data profile. An enrollment is not a login session or
an account deployment authorization by itself. The deployment service derives a fixed owner
configuration from verified enrollment; see `DEPLOYMENT.md` for its separate checks and limitations.

## Configuration

Set all three API variables together: `DATABASE_URL`, `WEBAUTHN_RP_ID`, and `WEBAUTHN_ORIGIN`.
For local development, use RP ID `localhost` and origin `http://localhost:3000`. Remote origins
must use HTTPS. Set `NEXT_PUBLIC_API_URL` to the API origin when building/running the web app.
No supplied variables means enrollment routes are absent; partial configuration fails startup.
The API startup checks for the migrated table; it does not create schema using runtime credentials.

Apply `services/api/migrations/001_enrollment.sql` to a dedicated PostgreSQL database with a
migration identity, then give the runtime identity only SELECT, INSERT, and UPDATE on
`account_enrollments`. Use managed TLS and appropriate network access for remote PostgreSQL.
Do not disable certificate validation. Raw bearer challenges are never logged or stored: only
the bearer token hash is stored alongside the WebAuthn challenge and public credential metadata.

Ceremonies expire after five minutes. A transaction locks the enrollment row while checking
and advancing its state (`register` → `prove` → `verified`). Concurrent verification can succeed
once. Failed verification rolls back; a lost success response requires restarting enrollment.
Database failures remain failures rather than producing a verified response. Registration does
not attest to the device manufacturer's identity (`attestation: none`); the proof verifies key
possession. There is no API key-based or email-based ownership fallback.

POSTs require the configured Origin and are limited to 20 requests per minute per connecting IP
per API process. This local limiter is not a distributed deployment-wide quota; configure a shared
edge limit before scaling. Trust-proxy headers are not enabled. Bodies are bounded to 32 KiB and
ceremony responses use `Cache-Control: no-store`. Configure retention and cleanup for expired
abandoned enrollments using an operator identity; no automated cleanup is implemented here.

## Verification

Run `pnpm --filter @openbalance/api test` with `ENROLLMENT_TEST_DATABASE_URL` pointing to a
dedicated test PostgreSQL database. Tests create an isolated random schema and remove that schema
afterward. They use generated P256 keys and real cryptographic verification, not mocked verifiers.
They exercise restart persistence, concurrent replay, challenge/origin/signature/verification
rejection, expiry, token isolation, and HTTP origin enforcement. Without the variable the three
PostgreSQL integration tests are explicitly skipped. Unit tests still run.

The browser route builds successfully but an actual browser/device ceremony has not been run.
Account creation from verified enrollment is tested locally as described in `DEPLOYMENT.md`.
No funding, authentication session, or production deployment is claimed.
