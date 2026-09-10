# Implementation checklist

## Completed

- [x] Initialized the isolated application repository with MIT licensing and repository hygiene.
- [x] Configured the pinned Node.js, pnpm workspace, Turborepo, TypeScript, and Biome toolchain.
- [x] Added the Next.js web shell, Fastify API health service, and shared protocol package.
- [x] Added exact base-unit amount and supported-network primitives with unit tests.
- [x] Configured Foundry and added tested Monad chain constants.
- [x] Generated the locked dependency graph and verified formatting, checks, tests, and builds.

## Passkey verification foundation

- [x] Pinned OpenZeppelin Contracts 5.6.1 and configured Foundry dependency resolution.
- [x] Added strict origin/RP, presence/verification, bounded client-data, and signature checks.
- [x] Added a non-payment probe with chain/contract/nonce/deadline-bound challenges.
- [x] Verified independent WebCrypto signing and replay rejection against a locally deployed probe.
- [x] Verified valid/invalid native P256 vectors with read-only Monad testnet calls (chain 10143).
- [x] Passed 15 Solidity tests (including 1,000-run fuzz cases), 10 TypeScript tests, checks, and builds.
- [x] Added repeatable local/testnet probe commands and excluded generated contract output from Biome.
- [ ] Verify a real browser passkey assertion and deployed testnet probe; no such proof is claimed.
- [ ] Implement account factory, ownership epochs, enrollment, sponsored commands, and recovery.

## Next verification gate

- [ ] Prove strict WebAuthn/P256 account ownership on Monad testnet, including valid and invalid
  assertions, replay/domain rejection, gas measurement, sponsored submission, and independent recovery.

No payment contract, live account flow, external integration, or deployment is claimed yet.
