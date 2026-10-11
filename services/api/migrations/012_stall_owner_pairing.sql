BEGIN;

-- The owner keeps using their invite link after submitting it: it becomes a status page and, once
-- the organizer has registered the stall, lets the owner show the terminal setup code themselves.
-- The organizer still approves the exact terminal key that checks in, so the link alone can never
-- make a stall sell. Only the SHA-256 of the link secret is stored.
ALTER TABLE stall_onboarding
  ADD COLUMN owner_token_hash text UNIQUE
    CHECK (owner_token_hash IS NULL OR owner_token_hash ~ '^[0-9a-f]{64}$'),
  -- Last time a phone holding this stall's setup code checked in (pending or live). One phone holds
  -- one setup at a time, so when the same terminal key last checked in for another stall, this one
  -- has no phone any more.
  ADD COLUMN terminal_seen_at timestamptz;

COMMIT;
