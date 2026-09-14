BEGIN;

CREATE TABLE organizer_configuration_operations (
  operation_id uuid PRIMARY KEY,
  stream_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  registry text NOT NULL CHECK (registry ~ '^0x[0-9a-f]{40}$'),
  organizer text NOT NULL CHECK (organizer ~ '^0x[0-9a-f]{40}$'),
  kind text NOT NULL CHECK (kind IN ('CONFIG','VENDOR','DESTINATION','TERMINAL')),
  aggregate_id text NOT NULL CHECK (char_length(aggregate_id) BETWEEN 1 AND 200),
  calldata text NOT NULL CHECK (calldata ~ '^0x([0-9a-f]{2})+$'),
  command_digest text NOT NULL CHECK (command_digest ~ '^0x[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','FINALIZED')),
  transaction_hash text UNIQUE CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
  prepared_block numeric(78,0) NOT NULL CHECK (prepared_block >= 0),
  prepared_block_hash text NOT NULL CHECK (prepared_block_hash ~ '^0x[0-9a-f]{64}$'),
  finalized_block numeric(78,0) CHECK (finalized_block IS NULL OR finalized_block >= prepared_block),
  finalized_block_hash text CHECK (finalized_block_hash IS NULL OR finalized_block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  UNIQUE (requested_by,idempotency_key),
  CHECK ((state='PREPARED' AND transaction_hash IS NULL AND finalized_block IS NULL
                           AND finalized_block_hash IS NULL AND finalized_at IS NULL)
      OR (state='FINALIZED' AND transaction_hash IS NOT NULL AND finalized_block IS NOT NULL
                            AND finalized_block_hash IS NOT NULL AND finalized_at IS NOT NULL))
);
CREATE INDEX organizer_configuration_scope_idx
  ON organizer_configuration_operations (stream_id,event_id,state,created_at DESC);

COMMIT;
