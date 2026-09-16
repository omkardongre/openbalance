CREATE TABLE IF NOT EXISTS faucet_grants (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  account text NOT NULL,
  amount text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','GRANTED','FAILED')),
  transaction_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_hash)
);

CREATE INDEX IF NOT EXISTS faucet_grants_day ON faucet_grants (chain_id, created_at);
