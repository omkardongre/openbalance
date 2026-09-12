# Terminal security boundary

The terminal package implements durable offline-sale state and authenticated relay upload. It does
not provide a device user interface, camera isolation, a trusted time source, or protected key storage.
Those controls belong to the installed terminal application and must be proven on target hardware.

## Required host controls

- Keep the journal encryption key and terminal signing key in platform-protected storage. Never
  place either key in application configuration, logs, backups, or the journal database.
- Bootstrap new channel snapshots with `bootstrapFinalizedChannel` over an authenticated RPC
  transport and a pinned deployment manifest. It reads code, bindings, channel state, registry
  history, recipients, fees, and windows from one finalized block and refuses spent or reclaimed
  channels. A terminal must not accept operator-entered signer, vault, limit, or deadline values.
- Use a trusted-time source and reject sales when clock confidence is outside the configured bound.
  `TerminalClock` and `prepareTimedSale` enforce the supplied sample's age, uncertainty, drift,
  continuity, and stored channel deadlines. The host must authenticate the source, include transport
  uncertainty, use a suspend-aware monotonic clock, and obtain a fresh sample after restart.
- Pin the relay origin configured for a channel. Upload uses HTTPS, rejects redirects, and binds the
  audience into every signed authorization.
- Treat `QUARANTINED` as a manual-review state. Never silently recreate or mutate a rejected voucher.

## Data protection

Sale payloads are encrypted with AES-256-GCM and authenticated against their stored payload hash.
Identifiers needed for uniqueness, ordering, leasing, and reconciliation remain visible in SQLite.
Device storage encryption, access control, backup policy, key rotation, and secure deletion remain
host responsibilities.

## Failure model

Acceptance is final only after both attendee and terminal signatures are durably stored. Network
timeouts are uncertain outcomes and therefore reuse the stored upload authorization until it ages
out. Duplicate delivery is expected; the relay must provide idempotent receipt handling.
