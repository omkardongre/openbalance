import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  type HTTPSendRequester,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  type Runtime,
  TxStatus,
} from "@chainlink/cre-sdk";
import {
  type Address,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const gas = z.string().regex(/^[1-9][0-9]{0,8}$/);

export const configSchema = z.object({
  schedule: z.string().min(1),
  chainSelectorName: z.string().min(1),
  // A regex rather than z.url(): the workflow WASM runtime has no URL global, so z.url() rejects
  // every value there.
  relayerUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/),
  eventId: bytes32,
  vault: address,
  reclaimTrigger: address,
  multicall: address,
  // Bounded by the EVM read payload quota: every channel adds two calls to one multicall read.
  maxChannelsPerRun: z.number().int().min(1).max(8),
  gasBase: gas,
  gasPerChannel: gas,
});

export type Config = z.infer<typeof configSchema>;

const listingSchema = z.object({
  eventId: bytes32,
  vault: address,
  channels: z.array(z.object({ channelId: bytes32 })),
});

export const vaultAbi = parseAbi([
  "function channelConfig(bytes32 channelId) view returns ((bytes32 channelId,bytes32 eventId,address asset,uint256 reserveUnits,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,uint256 terminalKeyVersion,address attendeeChannelSigner,uint256 configVersion,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 maxPerVoucher,uint32 maxVoucherCount,uint48 acceptFrom,uint48 acceptUntil,uint48 submitUntil,bytes32 genesisDigest))",
  "function channelState(bytes32 channelId) view returns (address originalAccount,uint256 spentGross,uint32 nextSequence,bytes32 lastVoucherDigest,bool reclaimed)",
]);

export const multicallAbi = parseAbi([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
  "function getCurrentBlockTimestamp() view returns (uint256 timestamp)",
]);

const reportParameters = parseAbiParameters("address vault, bytes32[] channelIds");

/**
 * Candidate channels from the relayer's finalized projection. Runs on every node; the identical
 * consensus means a run proceeds only when the nodes agree on the same candidate list.
 */
export const fetchCandidates = (requester: HTTPSendRequester, config: Config): string[] => {
  const response = requester
    .sendRequest({
      url: `${config.relayerUrl}/v1/events/${config.eventId}/reclaimable-channels?limit=${config.maxChannelsPerRun}`,
      method: "GET",
      timeout: "10s",
    })
    .result();
  if (response.statusCode !== 200)
    throw new Error(`reclaimable listing returned ${response.statusCode}`);
  const listing = listingSchema.parse(JSON.parse(new TextDecoder().decode(response.body)));
  if (
    listing.eventId.toLowerCase() !== config.eventId.toLowerCase() ||
    listing.vault.toLowerCase() !== config.vault.toLowerCase()
  )
    throw new Error("reclaimable listing describes a different event");
  return [...new Set(listing.channels.map((channel) => channel.channelId.toLowerCase()))]
    .sort()
    .slice(0, config.maxChannelsPerRun);
};

/**
 * Keeps only candidates the vault itself, at the last finalized block, shows as past their
 * submission deadline, not yet returned and still holding money. The listing only suggests; the
 * chain decides, so a wrong or stale listing costs no gas.
 */
export function verifyEligible(runtime: Runtime<Config>, candidates: Hex[]): Hex[] {
  const config = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Unknown chain selector name ${config.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const vault = config.vault as Address;
  const calls = [
    {
      target: config.multicall as Address,
      allowFailure: false,
      callData: encodeFunctionData({ abi: multicallAbi, functionName: "getCurrentBlockTimestamp" }),
    },
    ...candidates.flatMap((channelId) => [
      {
        target: vault,
        allowFailure: false,
        callData: encodeFunctionData({
          abi: vaultAbi,
          functionName: "channelConfig",
          args: [channelId],
        }),
      },
      {
        target: vault,
        allowFailure: false,
        callData: encodeFunctionData({
          abi: vaultAbi,
          functionName: "channelState",
          args: [channelId],
        }),
      },
    ]),
  ];
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: config.multicall as Address,
        data: encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [calls] }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const results = decodeFunctionResult({
    abi: multicallAbi,
    functionName: "aggregate3",
    data: bytesToHex(reply.data),
  });
  if (results.length !== calls.length) throw new Error("multicall returned a partial result");
  const finalizedTime = decodeFunctionResult({
    abi: multicallAbi,
    functionName: "getCurrentBlockTimestamp",
    data: results[0].returnData,
  });
  return candidates.filter((channelId, index) => {
    const channel = decodeFunctionResult({
      abi: vaultAbi,
      functionName: "channelConfig",
      data: results[1 + index * 2].returnData,
    });
    const [, spentGross, , , reclaimed] = decodeFunctionResult({
      abi: vaultAbi,
      functionName: "channelState",
      data: results[2 + index * 2].returnData,
    });
    return (
      channel.channelId.toLowerCase() === channelId &&
      channel.eventId.toLowerCase() === config.eventId.toLowerCase() &&
      !reclaimed &&
      BigInt(channel.submitUntil) <= finalizedTime &&
      channel.reserveUnits > spentGross
    );
  });
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config;
  const candidates = new cre.capabilities.HTTPClient()
    .sendRequest(
      runtime,
      fetchCandidates,
      consensusIdenticalAggregation<string[]>(),
    )(config)
    .result() as Hex[];
  if (candidates.length === 0) return "No reserves are due for return.";

  const eligible = verifyEligible(runtime, candidates);
  runtime.log(`Reserves due: ${candidates.length} listed, ${eligible.length} verified on chain`);
  if (eligible.length === 0) return "No listed reserve is returnable at the finalized block.";

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName });
  if (!network) throw new Error(`Unknown chain selector name ${config.chainSelectorName}`);
  const report = runtime
    .report({
      encodedPayload: hexToBase64(
        encodeAbiParameters(reportParameters, [config.vault as Address, eligible]),
      ),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  // Monad charges the declared gas limit, not gas used, so the limit scales with the batch.
  const gasLimit = BigInt(config.gasBase) + BigInt(config.gasPerChannel) * BigInt(eligible.length);
  const write = new cre.capabilities.EVMClient(network.chainSelector.selector)
    .writeReport(runtime, {
      receiver: config.reclaimTrigger,
      report,
      gasConfig: { gasLimit: gasLimit.toString() },
    })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS)
    throw new Error(`Reserve return transaction failed: ${write.errorMessage ?? write.txStatus}`);
  if (
    write.receiverContractExecutionStatus !== undefined &&
    write.receiverContractExecutionStatus !== 0
  )
    throw new Error("Reserve return trigger reverted");
  const transactionHash = bytesToHex(write.txHash ?? new Uint8Array(32));
  runtime.log(
    `Returned ${eligible.length} reserve(s): ${eligible.join(",")} tx ${transactionHash}`,
  );
  return `Returned ${eligible.length} reserve(s) in ${transactionHash}`;
};

export function initWorkflow(config: Config) {
  return [
    cre.handler(
      new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }),
      onCronTrigger,
    ),
  ];
}
