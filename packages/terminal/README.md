# Terminal core

This package implements the platform-neutral offline payment core used by an installed vendor
terminal. It does not provide a camera interface or claim Android hardware protection.

Implemented boundaries:

- bounded time confidence with sample expiry, drift growth, and boot/rollback invalidation;
- `prepareTimedSale` checks the entire time interval against stored channel deadlines before writing;
- finalized channel bootstrap verifies deployed bytecode, immutable bindings, registry history,
  recipient and fee snapshots, policy windows, and untouched channel state at one exact block;
- canonical, versioned payment-request and attendee-response QR payloads;
- exact voucher/request binding and attendee-channel signature verification;
- SQLite WAL storage with full synchronization and encrypted sale payloads;
- atomic sequence, cumulative-spend, and previous-digest advancement only after both signatures;
- ordered upload leases, bounded retry, permanent-rejection quarantine, and restart recovery;
- audience-, timestamp-, nonce-, key-version-, and payload-bound relay authentication;
- idempotent recovery when the relay commits a receipt but its acknowledgement is lost.

The database key and terminal signing key must be loaded from platform-protected storage by the host
application. Use `bootstrapFinalizedChannel` with a pinned deployment manifest to verify and register
a newly opened channel. The lower-level `registerChannel` remains available for controlled storage
recovery and rejects any changed snapshot, but it does not prove caller-supplied initialization data.

The host supplies an authenticated Unix-time interval anchored to a suspend-aware monotonic reading
and a boot identity. `TerminalClock` enforces configured age, uncertainty, and oscillator drift limits;
it does not authenticate or fetch that sample. Keep one clock per running host and acquire a fresh
sample after process restart. Wall-clock time and a finalized block timestamp alone are insufficient.
Use `prepareTimedSale` for host sale preparation. The lower-level `prepareSale` remains available and
does not enforce time confidence. Recheck time before accepting/signing the attendee response; this
package does not yet provide that installed-device controller.

Local tests exercise QR tampering, expiry, signature ownership, process restart, encrypted payload
storage, channel ordering, uncertain relay acknowledgement, replay-safe receipt creation, and
quarantine. Installed-device storage rollback, Android Keystore behavior, camera reliability,
trusted-time refresh, and public-network execution remain unproven.
