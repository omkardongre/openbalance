# Independent reserve return

Build the protocol and verifier packages first, then run:

```sh
node apps/web/scripts/reclaim-reserve.mjs /secure/path/request.json
```

The request contains `manifest` (the published verifier deployment manifest), `rpcUrl`,
`channelId`, and `caller` (an account that can pay gas). Preparation reads verified deployment
bindings, the channel's fixed original account, and its submission deadline from finalized
chain state, then simulates the exact permissionless reclaim. It prints the original recipient,
expected returned units, public block proof, and exact transaction. It does not require an
OpenBalance API, organizer credential, or attendee signature. Local chain 31337 and Monad
testnet 10143 are enabled; mainnet requires a separate reviewed release.

To submit, add `walletRpcUrl` for a user-controlled signing wallet RPC and pass `--submit`.
The wallet must expose `caller` on the same chain. Private keys are not accepted in the file.
Only the contract's original account receives the reserve; the gas-paying caller cannot redirect it.
Keep request files with private RPC URLs outside the source repository.

`SUBMITTED` means only that the wallet returned a transaction hash. Independently verify the
canonical finalized `ChannelReclaimed` event and original-account balance before calling the
return complete. A timeout can happen after broadcast: inspect chain state and the caller's
transactions before retrying. An already reclaimed channel is rejected during preparation.
