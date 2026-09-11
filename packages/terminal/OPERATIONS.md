# Terminal operations

## Startup

1. Load encryption and signing keys from platform-protected storage.
2. Open the journal and register finalized channel snapshots.
3. Recover expired upload leases before starting the upload loop.
4. Refuse offline acceptance if trusted time or channel provenance cannot be established.

## Sale lifecycle

`PREPARED` records reserve sequence and cumulative amount atomically. `ATTENDEE_SIGNED` preserves
the attendee response before the terminal signs. `ACCEPTED` is eligible for ordered upload.
`UPLOADING` is leased to one worker, then advances to `UPLOADED`, `RETRY`, or `QUARANTINED`.
Settlement confirmation is a separate finalized-chain observation that advances the sale to
`SETTLED`.

## Recovery

- On restart, recover incomplete signed exchanges before creating another request for that channel.
- Expired upload leases return to retry without changing the voucher or receipt identifier.
- Retry transient transport and server failures with bounded exponential backoff.
- Quarantine malformed acknowledgements, invalid local state, and permanent relay rejection.
- Reconcile uploaded receipts against finalized settlement events before reporting financial closure.

## Evidence to retain

Retain channel snapshot provenance, receipt identifiers, voucher digests, upload attempts, relay
acknowledgements, transaction hashes, and finalized settlement observations according to the event
operator's retention policy. Logs must contain identifiers and state transitions, not encrypted
payloads, signatures, keys, or personal data.

