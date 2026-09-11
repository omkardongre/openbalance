# Venue Relay

The venue relay accepts terminal-signed offline voucher receipts, stores them in an encrypted SQLite WAL journal, and submits them to the configured resilience vault when connectivity is available.

## Implemented boundaries

- `POST /v1/vouchers` validates a strict payload and two signatures from the enrolled terminal key: the voucher signature and a fresh audience-bound transport signature.
- Terminal authorization is scoped by terminal ID, key version, and channel ID through a finalized snapshot. Expired snapshots fail closed.
- The terminal nonce and receipt are persisted in one SQLite transaction. Exact retries are idempotent; changed payloads conflict.
- Receipts are ordered by channel. A later sequence cannot pass an unresolved earlier receipt.
- Submitted transactions remain eligible for reconciliation after process restart.
- The settlement processor checks finalized chain evidence before submission or retry. It records transaction hashes, applies bounded backoff, and quarantines permanent failures.
- The viem gateway simulates the exact `settleVoucher` call before broadcasting and accepts completion only from a matching finalized `VoucherSettled` event.

## Runtime configuration

The ingress server requires:

- `VENUE_RELAY_DATABASE_PATH`: persistent SQLite path.
- `VENUE_RELAY_KEY_PATH`: file containing 32 raw key bytes or 64 hexadecimal characters.
- `TERMINAL_SNAPSHOT_PATH`: finalized terminal/channel snapshot JSON.
- `TERMINAL_INGRESS_AUDIENCE`: exact public ingress URL included in terminal signatures.
- Optional `HOST`, `PORT`, and `TERMINAL_MAXIMUM_CLOCK_SKEW_SECONDS`.

The encryption key must be mounted separately from the database. The snapshot includes chain, registry, vault, finalized block evidence, expiry, and the terminal/version/channel scopes. Snapshot generation and live chain deployment remain separate operational responsibilities.

## Current proof boundary

Unit and service tests cover authenticated ingestion, signature and metadata rejection, durable nonce replay protection, encrypted restart recovery, ordered leasing, submitted-state recovery, uncertain-commit reconciliation, backoff, quarantine, and vault scoping. A real terminal client, public RPC submission, device interruption test, and deployed settlement worker are not yet proven.
