BEGIN;
CREATE TABLE IF NOT EXISTS account_enrollments (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  challenge text NOT NULL,
  rp_id text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL CHECK (status IN ('register', 'prove', 'verified')),
  credential jsonb,
  coordinates jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS account_enrollments_credential
  ON account_enrollments ((credential->>'id')) WHERE credential IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_enrollments_expiry ON account_enrollments(expires_at);
COMMIT;
