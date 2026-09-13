BEGIN;

CREATE TABLE checkout_orders (
  order_id uuid PRIMARY KEY,
  stream_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^0x[0-9a-f]{64}$'),
  terminal_instance_id text NOT NULL CHECK (terminal_instance_id ~ '^0x[0-9a-f]{64}$'),
  payment_id text UNIQUE CHECK (payment_id IS NULL OR payment_id ~ '^0x[0-9a-f]{64}$'),
  payer_account text CHECK (payer_account IS NULL OR payer_account ~ '^0x[0-9a-f]{40}$'),
  order_ref_hash text NOT NULL CHECK (order_ref_hash ~ '^0x[0-9a-f]{64}$'),
  order_version numeric(78,0) NOT NULL CHECK (order_version > 0),
  gross_units numeric(78,0) NOT NULL CHECK (gross_units > 0),
  encoded_intent text CHECK (encoded_intent IS NULL OR encoded_intent ~ '^0x([0-9a-f]{2})+$'),
  display jsonb NOT NULL,
  reserve_policy jsonb NOT NULL,
  state text NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED','BOUND','READY')),
  terminal_signature text CHECK (terminal_signature IS NULL OR terminal_signature ~ '^0x[0-9a-f]{130}$'),
  capability_hash text NOT NULL UNIQUE CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  bound_at timestamptz,
  ready_at timestamptz,
  UNIQUE (created_by, idempotency_key),
  UNIQUE (stream_id, vendor_id, order_ref_hash, order_version),
  CHECK ((state='CREATED' AND payer_account IS NULL AND payment_id IS NULL AND encoded_intent IS NULL
          AND terminal_signature IS NULL AND bound_at IS NULL AND ready_at IS NULL)
      OR (state='BOUND' AND payer_account IS NOT NULL AND payment_id IS NOT NULL AND encoded_intent IS NOT NULL
          AND terminal_signature IS NULL AND bound_at IS NOT NULL AND ready_at IS NULL)
      OR (state='READY' AND payer_account IS NOT NULL AND payment_id IS NOT NULL AND encoded_intent IS NOT NULL
          AND terminal_signature IS NOT NULL AND bound_at IS NOT NULL AND ready_at IS NOT NULL)),
  CHECK (jsonb_typeof(display)='object' AND jsonb_typeof(reserve_policy)='object')
);
CREATE INDEX checkout_orders_scope_idx
  ON checkout_orders (stream_id,event_id,vendor_id,created_at DESC);

COMMIT;
