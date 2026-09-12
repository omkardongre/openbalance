# OpenBalance relayer

The relayer submits already-authorized commands and never changes their economic fields. Account
deployment sponsorship and general financial operations use separate persistence paths.

Run `pnpm --filter @openbalance/relayer migrate` with only `DATABASE_URL` configured before starting
workers. The migration is checksum-locked and creates the financial-operation journal plus durable,
operation-bound nonce reservations.

Financial commands move through:

`ACCEPTED -> LEASED -> SIGNED -> SUBMITTED -> FINALIZED`

- Acceptance is idempotent for one actor, operation kind, and idempotency key. Reuse with different
  command bytes is a conflict.
- Workers claim with PostgreSQL row locks and a bounded fencing lease.
- A nonce reservation belongs to one operation and one signer. A restart returns the same reservation.
- Signed raw transaction bytes and their verified hash are durable before broadcast.
- A missing broadcast acknowledgement remains `SIGNED`; recovery rebroadcasts the same bytes or
  reconciles the known hash.
- Fee replacements preserve signer, nonce, and command, retain the prior hash, and require higher fee
  fields.
- `FINALIZED` requires an exact transaction and canonical-block proof supplied by the chain worker.
- Pre-signing failures may retry. Signed operations are reconciled or replaced, never rebuilt as a new
  economic command.

No generic public submission route is exposed. Authenticated attendee, vendor, terminal, and operator
boundaries must validate their own command type before calling the journal.
