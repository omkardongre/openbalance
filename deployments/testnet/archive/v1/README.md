# Testnet deployment v1 (superseded)

These addresses are **orphaned but not forgotten**. Contract migration is versioned rather than
overwritten, so the generation that a manifest, an evidence file, or a transcript refers to stays
resolvable after the redeploy. Nothing here is live; nothing here should be pointed at by running
code.

## Why it was superseded

v1 predates the payment-path contention work (ARCHITECTURE §8.4, §20.5). Its `SettlementLedger`,
`ExactPayRouter`, `ResilienceVault`, and `OpenBalanceAccount` still carry persistent `bool entered`
reentrancy locks and an unconditional `beneficiaryDestinations` write. Those are exactly the two
things the change removed, so v1 bytecode cannot be used to reproduce the post-change figures.

The children could not be upgraded in place. `EventFactory` embeds the creation code of the registry,
ledger, router, and vault, and `AccountFactory` embeds the account implementation, so new child
bytecode requires new factories, which requires a new event. That is why this is a generation change
and not a patch.

## v1 addresses (chain 10143)

| Contract | Address | Runtime code hash |
| --- | --- | --- |
| AccountFactory | `0x6003785770b668B742e37cD5c519ef7Ef3554BbC` | see `account-manifest.json` |
| EventFactory | `0xf45FE7551250400AD41f666d3bb42482642bd470` | — |
| EventRegistry | `0xcfC1f72a27c09FBE72F7f23428E85DB7D1Ab5eae` | `0xed88e4741a8a577b38bba60c5de1707d79a5989faabfdf2c222e9fb85379f68d` |
| SettlementLedger | `0xE4bdB9b42688e6C80D6EAC722c293DaEf58C97D8` | `0x8f59ad72f2fdc1c4d9df6f18f3f7eb7923bc0f694bfdabbc85645050698f8795` |
| ExactPayRouter | `0xE2d9e858d9CDa2e137BaC8ab7D6878e4B3a9cd48` | `0x1775dac6ed5b2cfed65969906c71525bfc78c2402b4b40c938653fa7b1f9a029` |
| ResilienceVault | `0xB407dA9e84B1DA9091837AEDdCB84d91Bb96eF43` | `0x67174a73d5847ed1a4ec6972127264cfa5fec0895b9feaff06a19e3d79ca6b35` |

- Event label: `openbalance:testnet:event:1`
- Event ID: `0x8b1e063dcbd16a795ae9978f60d5f8e92dee63e5762ea2fb9c6170f4f8b9936a`
- Deployment block: `64214896`
- Settlement asset: `0x534b2f3A21130d7a60830c2Df862319e593943A3` (Circle testnet USDC, 6 decimals)
- Deployer: `0xA9d0D013f0d541d2FF96ab254Bef318787f80F83`

## Funds

No migration of balances was performed, because none was owed. Monad testnet USDC has no value, and
v1 held no attendee credit that anyone is entitled to recover. Had this been mainnet, the pooled
custody in the v1 ledger would have had to be drained through the ordinary `withdrawFor` and refund
paths before the generation was abandoned — never by an admin sweep, which §8.5 does not provide.

## Related evidence

`evidence/contention/baseline-testnet-gas.json` was measured against a v1-generation ledger and
records its own code hash. It remains valid as the before-side testnet datapoint and is not
superseded by the redeploy.
