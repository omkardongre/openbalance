# Independent recovery client

Build the shared package with `pnpm --filter @openbalance/protocol build`.
Run `node apps/web/scripts/recover-account.mjs recovery-requests/request.json` to inspect the
recovery typed data without requesting a signature. Add `--sign` to request a signature and
simulate the command; add `--sign --submit` to also submit it and verify ownership read-back.
The wallet RPC must expose the enrolled recovery address and support `eth_signTypedData_v4`.
No private key is read by this client. Hardware-wallet RPC compatibility has not been verified.

The local JSON request contains:

- `chainId`: 31337 or 10143; mainnet is disabled.
- `account`: target account address.
- `rpcUrl`: read/simulation RPC; HTTPS or loopback HTTP only.
- `walletRpcUrl`: user-controlled signing RPC, used only with `--sign`.
- `accountCodeHash` and `implementationCodeHash`: keccak256 hashes from a trusted deployment
  record. Both the minimal clone and its embedded implementation are independently checked.
- `deadline`: decimal Unix seconds, within 15 minutes of the RPC block timestamp.
- `ownership`: `{ primary: { x, y }, backup: { x, y }, recovery }`; coordinates are 32-byte hex.
  Zero backup coordinates disable the backup; zero recovery address disables future wallet recovery.

Review all replacement keys before signing. This client does not enroll replacement passkeys or
prove possession of their private keys. Use only keys already verified through an enrollment
ceremony. An incorrect replacement can lose account access. The command replaces all ownership
and advances its epoch, revoking outstanding commands while preserving funds/account address.

The client reads current epoch, recovery nonce and signer at one block, independently calculates
the digest and compares it with the contract, then requests the exact typed signature. Signing
does not guarantee execution if another command changes authority before inclusion. Output with
`--sign` includes a usable recovery envelope until expiry; keep it private. The request/envelope
directories are gitignored. RPC credentials must never be committed.

For the local automated proof, run Anvil on port 8545, `forge build --root contracts`, then
`node apps/web/scripts/test-recovery.mjs`. The test deploys a disposable factory/account on chain
31337, verifies TypeScript/Solidity digest equality, invokes this CLI through Anvil's test signer,
confirms recovery, and proves a disabled signer cannot recover again. It never calls a public
network and does not prove hardware-wallet or live-testnet operation.
