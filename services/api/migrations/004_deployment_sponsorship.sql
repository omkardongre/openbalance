BEGIN;
CREATE TABLE IF NOT EXISTS deployment_sponsorships (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL UNIQUE REFERENCES account_enrollments(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  sponsor_address text NOT NULL,
  sponsor_nonce numeric(78,0) NOT NULL,
  transaction_hash text NOT NULL UNIQUE,
  raw_transaction text NOT NULL,
  gas_limit numeric(78,0) NOT NULL,
  max_fee_per_gas numeric(78,0) NOT NULL,
  max_priority_fee_per_gas numeric(78,0) NOT NULL,
  state text NOT NULL CHECK (state IN ('signed','submitted','confirmed','reverted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failure_code text,
  UNIQUE (sponsor_address, sponsor_nonce)
);
CREATE INDEX IF NOT EXISTS deployment_sponsorships_created
  ON deployment_sponsorships(created_at);
COMMIT;
