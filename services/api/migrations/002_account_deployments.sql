BEGIN;
CREATE TABLE IF NOT EXISTS account_deployments (
  enrollment_id uuid PRIMARY KEY REFERENCES account_enrollments(id),
  manifest_hash text NOT NULL,
  user_salt text NOT NULL,
  account_address text NOT NULL,
  parameters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_block numeric(78,0),
  verified_block_hash text,
  UNIQUE (manifest_hash, account_address)
);
COMMIT;
