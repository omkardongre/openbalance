CREATE TABLE projection_rebuilds (
  rebuild_id uuid PRIMARY KEY,
  stream_id text NOT NULL,
  shadow_schema text NOT NULL UNIQUE CHECK (shadow_schema ~ '^indexer_shadow_[0-9a-f]{32}$'),
  requested_by text NOT NULL CHECK (requested_by ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  state text NOT NULL CHECK (state IN ('BUILDING','READY','REJECTED','PROMOTED')),
  target_block bigint NOT NULL CHECK (target_block >= 0),
  target_block_hash text NOT NULL CHECK (target_block_hash ~ '^0x[0-9a-f]{64}$'),
  plan_digest text CHECK (plan_digest IS NULL OR plan_digest ~ '^[0-9a-f]{64}$'),
  changed_tables jsonb,
  source_fingerprint jsonb,
  shadow_fingerprint jsonb,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  promoted_at timestamptz,
  CHECK ((state IN ('READY','PROMOTED')) = (plan_digest IS NOT NULL AND changed_tables IS NOT NULL
    AND source_fingerprint IS NOT NULL AND shadow_fingerprint IS NOT NULL)),
  CHECK ((state='REJECTED') = (rejection_code IS NOT NULL)),
  CHECK ((state='PROMOTED') = (promoted_at IS NOT NULL))
);

CREATE UNIQUE INDEX projection_rebuilds_active_stream_idx
  ON projection_rebuilds (stream_id) WHERE state IN ('BUILDING','READY');
