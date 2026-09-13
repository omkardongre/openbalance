CREATE TABLE integration_jobs (
  transition_id text PRIMARY KEY,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'READY'
    CHECK (state IN ('READY','LEASED','RETRY','COMPLETED','QUARANTINED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  sales_invoice text,
  payment_entry text,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='LEASED') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state='COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (state<>'COMPLETED' OR (sales_invoice IS NOT NULL AND payment_entry IS NOT NULL))
);
CREATE INDEX integration_jobs_ready_idx
  ON integration_jobs (available_at,created_at,transition_id)
  WHERE state IN ('READY','RETRY');

CREATE TABLE integration_attempts (
  transition_id text NOT NULL REFERENCES integration_jobs(transition_id),
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_token uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED','RETRY','QUARANTINED')),
  error_code text,
  sales_invoice text,
  payment_entry text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transition_id,attempt)
);

CREATE TABLE integration_source_cursors (
  stream_id text PRIMARY KEY,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  transition_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
