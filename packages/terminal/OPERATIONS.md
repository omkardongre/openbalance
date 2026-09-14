# Terminal operations

## Startup

1. Load encryption and signing keys from platform-protected storage.
2. Open the journal and install each new channel through `bootstrapFinalizedChannel`; reuse the
   existing journal snapshot after restart rather than re-bootstrap an already-spent channel.
3. Recover expired upload leases before starting the upload loop.
4. Refuse offline acceptance if trusted time or channel provenance cannot be established.

`SignedHttpsTimeSource` accepts an HTTPS authority endpoint and an independently provisioned
Ed25519 public key. The authority must return JSON with `nonce`, `unixMs`, `uncertaintyMs`, and
a lowercase hex `signature` over `timeAttestationPayload(...)`. Its uncertainty must come from
monitored clock synchronization; signing an unchecked wall clock is not a trusted time service.
Every request uses a new nonce. The client verifies the signature, bounds response size and
round-trip duration, and includes the full elapsed request time in the latest possible instant.
The device must supply a suspend-aware monotonic clock and boot identity. No live authority or
Android adapter is configured by this package.

The controller checks the trusted window before signing and again after signature recovery,
immediately before the journal's synchronous acceptance transaction. If signing crosses expiry,
the attendee response remains durable but the terminal does not acknowledge acceptance.

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
