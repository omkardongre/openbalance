BEGIN;
CREATE TABLE IF NOT EXISTS account_authentication_challenges (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES account_enrollments(id),
  challenge_hash text NOT NULL UNIQUE,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_authentication_challenges_expiry
  ON account_authentication_challenges(expires_at);

CREATE TABLE IF NOT EXISTS account_sessions (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES account_enrollments(id),
  session_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
COMMIT;
