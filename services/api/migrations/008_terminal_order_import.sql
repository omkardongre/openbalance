BEGIN;

ALTER TABLE checkout_orders
  DROP CONSTRAINT checkout_orders_state_check,
  DROP CONSTRAINT checkout_orders_check;

ALTER TABLE checkout_orders
  ADD COLUMN offline_imported_at timestamptz,
  ADD CONSTRAINT checkout_orders_state_check
    CHECK (state IN ('CREATED','OFFLINE_IMPORTED','BOUND','READY')),
  ADD CONSTRAINT checkout_orders_transition_check CHECK (
    (state='CREATED' AND payer_account IS NULL AND payment_id IS NULL AND encoded_intent IS NULL
      AND terminal_signature IS NULL AND bound_at IS NULL AND ready_at IS NULL
      AND offline_imported_at IS NULL)
    OR (state='OFFLINE_IMPORTED' AND payer_account IS NULL AND payment_id IS NULL
      AND encoded_intent IS NULL AND terminal_signature IS NULL AND bound_at IS NULL
      AND ready_at IS NULL AND offline_imported_at IS NOT NULL)
    OR (state='BOUND' AND payer_account IS NOT NULL AND payment_id IS NOT NULL
      AND encoded_intent IS NOT NULL AND terminal_signature IS NULL AND bound_at IS NOT NULL
      AND ready_at IS NULL AND offline_imported_at IS NULL)
    OR (state='READY' AND payer_account IS NOT NULL AND payment_id IS NOT NULL
      AND encoded_intent IS NOT NULL AND terminal_signature IS NOT NULL AND bound_at IS NOT NULL
      AND ready_at IS NOT NULL AND offline_imported_at IS NULL)
  );

CREATE TABLE terminal_provisioning_challenges (
  challenge_hash text PRIMARY KEY CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  stream_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^0x[0-9a-f]{64}$'),
  terminal_instance_id text NOT NULL CHECK (terminal_instance_id ~ '^0x[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX terminal_provisioning_challenge_expiry_idx
  ON terminal_provisioning_challenges (expires_at) WHERE used_at IS NULL;

COMMIT;
