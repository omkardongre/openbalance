# WebAuthn compatibility probe

The probe validates assertions and consumes a domain-bound nonce. It does not hold funds or implement
account ownership, enrollment, sessions, or recovery. Do not deploy it as a user wallet.

Install the locked workspace dependencies and run `forge build --root contracts` from the repository
root. Use the Foundry executable (not an unrelated npm command named forge).

Local independent verification:

1. Start `anvil` with its default local network.
2. Run `node apps/web/scripts/probe-webauthn.mjs` from the repository root.
3. The script generates an ephemeral non-exportable WebCrypto key, deploys the probe using an unlocked
   local account, submits an assertion, reads back the nonce, and requires replay rejection.

Read-only native-precompile verification:

```sh
node apps/web/scripts/probe-webauthn.mjs --testnet
```

This checks network ID 10143 and submits valid and invalid P256 vectors using eth_call. It does not
deploy a contract, spend gas, or prove browser compatibility. No account credentials are required.

The strict assertion profile accepts ordered type, challenge, and origin fields, optionally followed
by crossOrigin:false. Unknown fields, alternate serializations, cross-origin assertions, extensions,
and attested data are rejected. Origin/RP policy is immutable. Full client-data equality prevents
duplicate-field and substring-offset bypasses. User presence and verification are mandatory.

The profile is deliberately narrow pending real browser/device tests. A compatible browser assertion
must be verified byte-for-byte before widening the profile. Browser registration requires separate
server-issued challenge, attestation/public-key binding, origin/RP validation, and durable replay
protection; these are not implemented by this assertion probe.

Outstanding evidence: actual browser/authenticator assertion, target-network deployed probe gas,
smart-account factory initialization, epoch/nonces, enrolled second-passkey and independent hardware
recovery, and sponsored command submission through the account. Public-network deployment needs a
testnet-funded deployment signer configured locally; do not share its private key in chat.
