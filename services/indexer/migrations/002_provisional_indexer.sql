CREATE TABLE provisional_cursors (
  stream_id text PRIMARY KEY,
  chain_id numeric(78,0) NOT NULL CHECK (chain_id > 0),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE provisional_blocks (
  stream_id text NOT NULL,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  parent_hash text NOT NULL CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stream_id,block_number),
  UNIQUE (stream_id,block_hash)
);

CREATE TABLE provisional_chain_logs (
  transition_id text NOT NULL,
  stream_id text NOT NULL,
  chain_id numeric(78,0) NOT NULL CHECK (chain_id > 0),
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  block_number bigint NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  log_index integer NOT NULL CHECK (log_index >= 0),
  transition_kind text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (stream_id,transition_id),
  FOREIGN KEY (stream_id,block_number) REFERENCES provisional_blocks(stream_id,block_number)
);
CREATE INDEX provisional_chain_logs_order_idx
  ON provisional_chain_logs (stream_id,block_number,transaction_index,log_index);

CREATE TABLE provisional_promotions (
  stream_id text NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  transition_count integer NOT NULL CHECK (transition_count >= 0),
  status text NOT NULL CHECK (status IN ('VERIFIED')),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (stream_id,block_number)
);

COMMENT ON TABLE provisional_chain_logs IS
  'Non-authoritative latest-block observations; no financial or integration worker may consume this table.';
