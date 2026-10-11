BEGIN;

-- One row per stall an organizer invites. The registry on chain stays the source of truth: a stall
-- only becomes APPROVED or LIVE after its vendor, payout destination and terminal are read back
-- from the registry at a finalized block. This table carries the invite, the owner's signed payout
-- approval while it waits for review, and the terminal key a paired device proved it holds.
CREATE TABLE stall_onboarding (
  stall_id uuid PRIMARY KEY,
  stream_id text NOT NULL,
  event_id text NOT NULL CHECK (event_id ~ '^0x[0-9a-f]{64}$'),
  vendor_id text NOT NULL UNIQUE CHECK (vendor_id ~ '^0x[0-9a-f]{64}$'),
  terminal_instance_id text NOT NULL UNIQUE CHECK (terminal_instance_id ~ '^0x[0-9a-f]{64}$'),
  terminal_key_version numeric(78,0) NOT NULL DEFAULT 1 CHECK (terminal_key_version >= 1),
  destination_version numeric(78,0) NOT NULL DEFAULT 1 CHECK (destination_version >= 1),
  invite_label text NOT NULL CHECK (char_length(invite_label) BETWEEN 1 AND 80),
  -- SHA-256 of the single-use invite secret; cleared once the owner submits.
  invite_token_hash text UNIQUE CHECK (invite_token_hash IS NULL OR invite_token_hash ~ '^[0-9a-f]{64}$'),
  invite_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'INVITED'
    CHECK (state IN ('INVITED','SUBMITTED','DECLINED','APPROVED','LIVE')),
  stall_name text CHECK (stall_name IS NULL OR char_length(stall_name) BETWEEN 2 AND 60),
  category text CHECK (category IS NULL OR char_length(category) BETWEEN 2 AND 40),
  authority text CHECK (authority IS NULL OR authority ~ '^0x[0-9a-f]{40}$'),
  payout_address text CHECK (payout_address IS NULL OR payout_address ~ '^0x[0-9a-f]{40}$'),
  destination_deadline numeric(78,0) CHECK (destination_deadline IS NULL OR destination_deadline > 0),
  vendor_signature text CHECK (vendor_signature IS NULL OR vendor_signature ~ '^0x[0-9a-f]{130}$'),
  submitted_at timestamptz,
  pending_terminal_signer text
    CHECK (pending_terminal_signer IS NULL OR pending_terminal_signer ~ '^0x[0-9a-f]{40}$'),
  pending_terminal_seen_at timestamptz,
  terminal_signer text CHECK (terminal_signer IS NULL OR terminal_signer ~ '^0x[0-9a-f]{40}$'),
  setup_credential_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  live_at timestamptz,
  CHECK (state IN ('INVITED','DECLINED') OR (
    stall_name IS NOT NULL AND authority IS NOT NULL AND payout_address IS NOT NULL
    AND destination_deadline IS NOT NULL AND vendor_signature IS NOT NULL AND submitted_at IS NOT NULL
  )),
  CHECK (state <> 'INVITED' OR invite_token_hash IS NOT NULL),
  CHECK (state <> 'LIVE' OR (terminal_signer IS NOT NULL AND live_at IS NOT NULL)),
  CHECK (state NOT IN ('APPROVED','LIVE') OR approved_at IS NOT NULL)
);
CREATE INDEX stall_onboarding_event_idx ON stall_onboarding (stream_id,event_id,created_at DESC);

COMMIT;
