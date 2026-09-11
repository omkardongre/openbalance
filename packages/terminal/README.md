# Terminal core

This package implements the platform-neutral offline payment core used by an installed vendor
terminal. It does not provide a camera interface or claim Android hardware protection.

Implemented boundaries:

- canonical, versioned payment-request and attendee-response QR payloads;
- exact voucher/request binding and attendee-channel signature verification;
- SQLite WAL storage with full synchronization and encrypted sale payloads;
- atomic sequence, cumulative-spend, and previous-digest advancement only after both signatures;
- ordered upload leases, bounded retry, permanent-rejection quarantine, and restart recovery;
- audience-, timestamp-, nonce-, key-version-, and payload-bound relay authentication;
- idempotent recovery when the relay commits a receipt but its acknowledgement is lost.

The database key and terminal signing key must be loaded from platform-protected storage by the host
application. A channel snapshot must be independently verified against finalized deployment and
registry state before `registerChannel` is called. The package rejects changed snapshots but cannot
prove the origin of caller-supplied initialization data.

Local tests exercise QR tampering, expiry, signature ownership, process restart, encrypted payload
storage, channel ordering, uncertain relay acknowledgement, replay-safe receipt creation, and
quarantine. Installed-device storage rollback, Android Keystore behavior, camera reliability,
trusted-time refresh, and public-network execution remain unproven.
