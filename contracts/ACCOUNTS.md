# Account ownership core

`AccountFactory` deploys a fixed implementation and creates deterministic ERC-1167 clones.
Creation and initialization are atomic. The salt hashes the full initial ownership, RP ID hash,
origin, and user salt. Repeated creation returns the existing account without resetting its state.
There is no administrator or upgrade entry point.

Each account stores one required primary P256 key, one optional backup P256 key, and an optional
secp256k1 recovery address. The backup is absent only when both coordinates are zero. Either
passkey can withdraw tokens or replace the entire ownership configuration. Recovery replaces
ownership through an EIP-712 signature; it cannot redirect balances. The account address, RP ID
hash, and origin remain unchanged. A replacement with no backup/recovery explicitly disables them.

## Command encoding

Domain: name `OpenBalanceAccount`, version `1`, current chain ID and account address.
Type: `Command(bytes32 action,bytes32 terms,uint256 epoch,uint256 nonce,uint256 deadline)`.
Actions are keccak256 of the UTF-8 strings `WITHDRAW`, `ROTATE`, or `RECOVER`.

- Withdrawal terms: `keccak256(abi.encode(asset, recipient, amount))`.
- Rotation/recovery terms: `keccak256(abi.encode(ownership))`; the tuple is
  `((bytes32 x,bytes32 y) primary,(bytes32 x,bytes32 y) backup,address recovery)`.
- Withdrawal/rotation use `nonce`; recovery uses `recoveryNonce` in the typed nonce field.
- Passkey challenge is the raw 32-byte EIP-712 digest, base64url encoded in client data.
- Recovery uses a canonical 65-byte secp256k1 EIP-712 signature, not a personal-sign prefix.
- All commands require current epoch and `block.timestamp < deadline`. Nonces advance on
  success; reverted transfers roll back consumption. Every ownership replacement advances epoch.

Any gas-paying caller can relay these signed commands. No fee reimbursement or gas sponsorship
service is implemented. The withdrawal path supports standard ERC-20 transfers; rebasing and
fee-on-transfer tokens are outside the intended asset policy. There is no native-token withdrawal.

## Verified scope

Run `forge test --root contracts --match-contract OpenBalanceAccountTest` from the repository root.
Tests exercise real signature verification, initialization locks, address prediction, relay/replay,
altered terms/domain/action, backup rotation, recovery revocation, new-key use, expiry, malformed
recovery signatures, transfer rollback, and fuzzed token conservation.

This is a locally tested ownership core. Browser registration and proof of key possession are
not performed by the factory; public keys alone are insufficient enrollment evidence. Browser
assertion compatibility, hardware-wallet signing, and testnet deployment remain unproven. The
independent recovery client and its local Anvil proof are described in
`apps/web/scripts/RECOVERY.md`; database-backed enrollment is in `services/api/ENROLLMENT.md`.
ERC-1271 consumer restrictions, online sessions, payments, and reserve commands remain unimplemented.
No production readiness or audit is claimed. Since clones are immutable, later account
implementations require new deployments; these development accounts are not a final funding target.
