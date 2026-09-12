BEGIN;

CREATE TABLE IF NOT EXISTS operations_access_credentials (
  credential_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  principal_id text NOT NULL CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$'),
  role text NOT NULL CHECK (role IN ('VENDOR','ORGANIZER','FINANCE','SUPPORT')),
  stream_id text NOT NULL CHECK (char_length(stream_id) BETWEEN 3 AND 255),
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  vendor_id text CHECK (vendor_id IS NULL OR vendor_id ~ '^0x[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  CHECK ((role = 'VENDOR' AND vendor_id IS NOT NULL) OR (role <> 'VENDOR' AND vendor_id IS NULL))
);
CREATE INDEX IF NOT EXISTS operations_access_scope_idx
  ON operations_access_credentials (stream_id, event_id, role)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS operations_vendor_beneficiaries (
  stream_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^0x[0-9a-f]{64}$'),
  beneficiary_id text NOT NULL CHECK (beneficiary_id ~ '^0x[0-9a-f]{64}$'),
  destination text NOT NULL CHECK (destination ~ '^0x[0-9a-f]{40}$'),
  approved_reference text NOT NULL CHECK (char_length(approved_reference) BETWEEN 1 AND 255),
  valid_from_block bigint NOT NULL CHECK (valid_from_block >= 0),
  valid_to_block bigint CHECK (valid_to_block IS NULL OR valid_to_block >= valid_from_block),
  PRIMARY KEY (stream_id, beneficiary_id),
  UNIQUE (stream_id, vendor_id, destination, valid_from_block)
);

CREATE TABLE IF NOT EXISTS operational_incidents (
  incident_id uuid PRIMARY KEY,
  stream_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  affected_vendor_id text CHECK (affected_vendor_id IS NULL OR affected_vendor_id ~ '^0x[0-9a-f]{64}$'),
  affected_terminal_id text CHECK (affected_terminal_id IS NULL OR affected_terminal_id ~ '^0x[0-9a-f]{64}$'),
  severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 5 AND 500),
  mitigation text NOT NULL CHECK (char_length(mitigation) BETWEEN 1 AND 2000),
  next_action text NOT NULL CHECK (char_length(next_action) BETWEEN 1 AND 1000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner text NOT NULL CHECK (owner ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  opened_by text NOT NULL,
  opened_by_role text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolution_proof text CHECK (resolution_proof IS NULL OR char_length(resolution_proof) BETWEEN 1 AND 2000),
  resolved_by text,
  resolution_idempotency_key text,
  resolution_hash text CHECK (resolution_hash IS NULL OR resolution_hash ~ '^0x[0-9a-f]{64}$'),
  UNIQUE (opened_by, idempotency_key),
  UNIQUE (resolved_by, resolution_idempotency_key),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL AND resolution_proof IS NULL AND resolved_by IS NULL
                           AND resolution_idempotency_key IS NULL AND resolution_hash IS NULL)
      OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolution_proof IS NOT NULL AND resolved_by IS NOT NULL
                               AND resolution_idempotency_key IS NOT NULL AND resolution_hash IS NOT NULL)),
  CHECK (jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) <= 20)
);
CREATE INDEX IF NOT EXISTS operational_incidents_scope_idx
  ON operational_incidents (stream_id, event_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS operational_incident_actions (
  action_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES operational_incidents(incident_id),
  action_kind text NOT NULL CHECK (action_kind IN ('OPENED','RESOLVED')),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (incident_id, action_kind)
);

COMMIT;
