BEGIN;
-- A discoverable sign-in challenge is issued before the account is known: the passkey the browser
-- returns names the enrollment, so the challenge carries no enrollment until it is verified.
ALTER TABLE account_authentication_challenges ALTER COLUMN enrollment_id DROP NOT NULL;
COMMIT;
