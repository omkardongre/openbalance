CREATE TABLE indexer_cursors (
  stream_id text PRIMARY KEY,
  chain_id numeric(78,0) NOT NULL CHECK (chain_id > 0),
  deployment_block bigint NOT NULL CHECK (deployment_block >= 0),
  block_number bigint NOT NULL CHECK (block_number >= deployment_block),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE finalized_chain_logs (
  transition_id text PRIMARY KEY,
  stream_id text NOT NULL,
  chain_id numeric(78,0) NOT NULL CHECK (chain_id > 0),
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  transition_kind text NOT NULL,
  payload jsonb NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (chain_id, block_hash, transaction_hash, log_index)
);
CREATE INDEX finalized_chain_logs_stream_block_idx
  ON finalized_chain_logs (stream_id, block_number, transaction_index, log_index);

CREATE TABLE payment_projections (
  stream_id text NOT NULL,
  payment_id text NOT NULL CHECK (payment_id ~ '^0x[0-9a-f]{64}$'),
  mode text NOT NULL CHECK (mode IN ('ONLINE', 'OFFLINE')),
  payer text CHECK (payer IS NULL OR payer ~ '^0x[0-9a-f]{40}$'),
  vendor_id text CHECK (vendor_id IS NULL OR vendor_id ~ '^0x[0-9a-f]{64}$'),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^0x[0-9a-f]{64}$'),
  gross_units numeric(78,0) NOT NULL CHECK (gross_units > 0),
  organizer_fee_units numeric(78,0) CHECK (organizer_fee_units >= 0),
  platform_fee_units numeric(78,0) CHECK (platform_fee_units >= 0),
  allocation_status text NOT NULL CHECK (allocation_status IN ('EVENT_VERIFIED','READBACK_REQUIRED')),
  transition_id text NOT NULL UNIQUE REFERENCES finalized_chain_logs(transition_id),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (stream_id, payment_id)
);

CREATE TABLE payment_cancellations (
  stream_id text NOT NULL,
  payment_id text NOT NULL,
  payer text NOT NULL,
  transition_id text NOT NULL UNIQUE REFERENCES finalized_chain_logs(transition_id),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (stream_id, payment_id)
);

CREATE TABLE channel_projections (
  stream_id text NOT NULL,
  channel_id text NOT NULL CHECK (channel_id ~ '^0x[0-9a-f]{64}$'),
  original_account text NOT NULL CHECK (original_account ~ '^0x[0-9a-f]{40}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^0x[0-9a-f]{64}$'),
  terminal_instance_id text NOT NULL CHECK (terminal_instance_id ~ '^0x[0-9a-f]{64}$'),
  reserve_units numeric(78,0) NOT NULL CHECK (reserve_units > 0),
  spent_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (spent_units >= 0 AND spent_units <= reserve_units),
  returned_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (returned_units >= 0 AND returned_units <= reserve_units),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0 AND next_sequence < 4294967296),
  accept_until bigint NOT NULL CHECK (accept_until >= 0),
  submit_until bigint NOT NULL CHECK (submit_until > accept_until),
  reclaimed boolean NOT NULL DEFAULT false,
  opened_transition_id text NOT NULL UNIQUE REFERENCES finalized_chain_logs(transition_id),
  last_transition_id text NOT NULL REFERENCES finalized_chain_logs(transition_id),
  PRIMARY KEY (stream_id, channel_id)
);

CREATE TABLE voucher_projections (
  stream_id text NOT NULL,
  channel_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0 AND sequence < 4294967296),
  payment_id text NOT NULL,
  gross_units numeric(78,0) NOT NULL CHECK (gross_units > 0),
  cumulative_gross_units numeric(78,0) NOT NULL CHECK (cumulative_gross_units >= gross_units),
  voucher_digest text NOT NULL CHECK (voucher_digest ~ '^0x[0-9a-f]{64}$'),
  transition_id text NOT NULL UNIQUE REFERENCES finalized_chain_logs(transition_id),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (stream_id, channel_id, sequence),
  UNIQUE (stream_id, payment_id),
  FOREIGN KEY (stream_id, channel_id) REFERENCES channel_projections(stream_id, channel_id)
);

CREATE TABLE refund_projections (
  stream_id text NOT NULL,
  refund_id text NOT NULL,
  payment_id text NOT NULL,
  payer text NOT NULL,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units > 0),
  vendor_credit_units numeric(78,0) NOT NULL CHECK (vendor_credit_units >= 0 AND vendor_credit_units <= amount_units),
  transition_id text NOT NULL UNIQUE REFERENCES finalized_chain_logs(transition_id),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (stream_id, refund_id),
  FOREIGN KEY (stream_id, payment_id) REFERENCES payment_projections(stream_id, payment_id)
);

CREATE TABLE withdrawal_projections (
  stream_id text NOT NULL,
  transition_id text NOT NULL PRIMARY KEY REFERENCES finalized_chain_logs(transition_id),
  beneficiary_id text NOT NULL,
  destination text NOT NULL,
  amount_units numeric(78,0) NOT NULL CHECK (amount_units > 0),
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL
);

CREATE TABLE projection_totals (
  stream_id text PRIMARY KEY,
  ledger_liability_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (ledger_liability_units >= 0),
  vault_reserved_units numeric(78,0) NOT NULL DEFAULT 0 CHECK (vault_reserved_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE balanced_journal_batches (
  transition_id text PRIMARY KEY REFERENCES finalized_chain_logs(transition_id),
  stream_id text NOT NULL,
  debit_units numeric(78,0) NOT NULL CHECK (debit_units >= 0),
  credit_units numeric(78,0) NOT NULL CHECK (credit_units >= 0),
  CHECK (debit_units = credit_units)
);

CREATE TABLE balanced_journal_entries (
  transition_id text NOT NULL REFERENCES balanced_journal_batches(transition_id),
  line_number smallint NOT NULL CHECK (line_number > 0),
  account_key text NOT NULL,
  side text NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
  units numeric(78,0) NOT NULL CHECK (units > 0),
  PRIMARY KEY (transition_id, line_number)
);

CREATE TABLE transition_outbox (
  transition_id text PRIMARY KEY REFERENCES finalized_chain_logs(transition_id),
  stream_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  lease_owner text,
  lease_until timestamptz
);
CREATE INDEX transition_outbox_ready_idx
  ON transition_outbox (available_at, transition_id) WHERE published_at IS NULL;

CREATE TABLE reconciliation_runs (
  run_id text PRIMARY KEY,
  stream_id text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  expected_ledger_liability numeric(78,0) NOT NULL,
  actual_ledger_liability numeric(78,0) NOT NULL,
  expected_vault_reserved numeric(78,0) NOT NULL,
  actual_vault_reserved numeric(78,0) NOT NULL,
  status text NOT NULL CHECK (status IN ('MATCHED','DIFFERENT')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (stream_id, block_hash)
);

CREATE TABLE reconciliation_differences (
  run_id text NOT NULL REFERENCES reconciliation_runs(run_id),
  metric text NOT NULL CHECK (metric IN ('LEDGER_LIABILITY','VAULT_RESERVED')),
  expected_units numeric(78,0) NOT NULL,
  actual_units numeric(78,0) NOT NULL,
  PRIMARY KEY (run_id, metric)
);

CREATE TABLE integrity_incidents (
  incident_id text PRIMARY KEY,
  stream_id text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('HIGH','CRITICAL')),
  block_number bigint,
  expected_block_hash text,
  observed_block_hash text,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX integrity_incidents_open_code_idx
  ON integrity_incidents (stream_id, code) WHERE status = 'OPEN';
