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

`FinancialOperationWorker` is the execution loop. It expires abandoned work, reconciles known signed
transactions first, claims new commands with a fencing lease, checks a fixed target/selector and gas
policy, simulates the exact call, reserves a signer nonce, persists signed bytes, and only then
broadcasts. A broadcast timeout defers reconciliation of those same bytes; it never signs a replacement
command. `ViemFinancialTransactionGateway` supplies direct EIP-1559 transport.

Set `FINANCIAL_EVENT_MANIFEST_PATH` on the request service to enable attendee financial commands. The
versioned JSON manifest fixes `chainId` and each event's `eventId`, router, vault, ledger, asset, and
deployment block. `POST /v1/accounts/commands` authenticates the deployed account, decodes only payment,
cancellation, or reserve-open account calls, derives rather than accepts the target and aggregate ID,
and rejects cross-account or cross-event payloads. The reclaim endpoint verifies finalized channel
ownership and the fixed submission deadline before constructing the vault call itself. No endpoint
accepts a caller-selected target address. Startup also checks the RPC chain, deployed bytecode, event
IDs, asset, shared registry, and router/vault/ledger bindings at finalized state; a stale or fabricated
manifest prevents the service from accepting commands.

Run `start:financial-worker` as a persistent process, separately from request-only hosting. It requires
the financial manifest, RPC/network configuration, a private signer file, worker identity, and explicit
gas/fee/cost ceilings. `DatabaseFinancialCommandPolicy` permits attendee calls only to verified account
deployments and direct calls only to manifest-pinned event contracts. `ViemFinancialFinalityVerifier`
checks the canonical finalized block and the exact operation-specific domain event; a successful receipt
without the expected economic event is quarantined rather than reported as complete.

Vendor refund and withdrawal endpoints use separately provisioned, expiring treasury credentials whose
hashes and exact event/vendor/authority scopes are stored by migration `002`. The HTTP credential grants
API access and sponsorship only: every refund still carries the vendor authority's EIP-712 signature,
which is recovered and scope-checked before journaling and verified again by the contract. Withdrawal
calldata and its beneficiary ID are derived server-side and the contract pays only the immutable
destination. Credential issuance and rotation remain an operator action; plaintext tokens are never
stored by this service. No generic public submission route is exposed.
