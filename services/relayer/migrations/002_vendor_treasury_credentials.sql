BEGIN;

CREATE TABLE IF NOT EXISTS vendor_treasury_credentials (
  credential_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^0x[0-9a-f]{64}$'),
  authority_address text NOT NULL CHECK (authority_address ~ '^0x[0-9a-f]{40}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, vendor_id, credential_id)
);

CREATE INDEX IF NOT EXISTS vendor_treasury_credentials_active
  ON vendor_treasury_credentials(token_hash, expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
