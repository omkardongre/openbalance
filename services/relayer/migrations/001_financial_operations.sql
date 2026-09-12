BEGIN;

CREATE TABLE IF NOT EXISTS financial_operations (
  operation_id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  operation_kind text NOT NULL CHECK (
    operation_kind IN ('PAYMENT','CANCELLATION','REFUND','RESERVE_OPEN','RESERVE_RECLAIM','WITHDRAWAL')
  ),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  command_digest text NOT NULL CHECK (command_digest ~ '^0x[0-9a-f]{64}$'),
  aggregate_id text NOT NULL CHECK (aggregate_id ~ '^0x[0-9a-f]{64}$'),
  target_address text NOT NULL CHECK (target_address ~ '^0x[0-9a-f]{40}$'),
  calldata text NOT NULL CHECK (calldata ~ '^0x([0-9a-f]{2})*$'),
  state text NOT NULL CHECK (
    state IN ('ACCEPTED','LEASED','SIGNED','SUBMITTED','FINALIZED','RETRY','FAILED','QUARANTINED')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  signer_address text CHECK (signer_address IS NULL OR signer_address ~ '^0x[0-9a-f]{40}$'),
  transaction_nonce numeric(78,0),
  transaction_hash text CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  raw_transaction text CHECK (raw_transaction IS NULL OR raw_transaction ~ '^0x([0-9a-f]{2})+$'),
  gas_limit numeric(78,0),
  max_fee_per_gas numeric(78,0),
  max_priority_fee_per_gas numeric(78,0),
  replacement_lineage jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamptz,
  finalized_at timestamptz,
  finalized_block_number numeric(78,0),
  finalized_block_hash text CHECK (
    finalized_block_hash IS NULL OR finalized_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, operation_kind, idempotency_key),
  CHECK (
    (state = 'LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR state <> 'LEASED'
  ),
  CHECK (
    state NOT IN ('SIGNED','SUBMITTED','FINALIZED')
    OR (
      signer_address IS NOT NULL
      AND transaction_nonce IS NOT NULL
      AND transaction_hash IS NOT NULL
      AND raw_transaction IS NOT NULL
      AND gas_limit IS NOT NULL
      AND max_fee_per_gas IS NOT NULL
      AND max_priority_fee_per_gas IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_operations_signer_nonce
  ON financial_operations(signer_address, transaction_nonce)
  WHERE signer_address IS NOT NULL AND transaction_nonce IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_operations_ready
  ON financial_operations(state, next_attempt_at, created_at)
  WHERE state IN ('ACCEPTED','RETRY');

CREATE INDEX IF NOT EXISTS financial_operations_unsettled_transaction
  ON financial_operations(transaction_hash)
  WHERE state IN ('SIGNED','SUBMITTED');

CREATE TABLE IF NOT EXISTS relayer_nonce_cursors (
  signer_address text PRIMARY KEY CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  next_nonce numeric(78,0) NOT NULL CHECK (next_nonce >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS relayer_nonce_reservations (
  operation_id uuid PRIMARY KEY REFERENCES financial_operations(operation_id),
  signer_address text NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
  transaction_nonce numeric(78,0) NOT NULL CHECK (transaction_nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (signer_address, transaction_nonce)
);

COMMIT;
