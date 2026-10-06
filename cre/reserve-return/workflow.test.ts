import { describe, expect } from "bun:test";
import { hexToBase64 } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import {
  bytesToHex,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  keccak256,
  stringToHex,
  zeroHash,
} from "viem";
import { type Config, multicallAbi, onCronTrigger, vaultAbi } from "./workflow";

const MONAD_TESTNET = 2183018362218727504n;
const due = keccak256(stringToHex("channel:due"));
const unknown = keccak256(stringToHex("channel:unknown"));
const config: Config = {
  schedule: "0 */1 * * * *",
  chainSelectorName: "monad-testnet",
  relayerUrl: "https://relayer.example",
  eventId: keccak256(stringToHex("event")),
  vault: "0x0000000000000000000000000000000000000606",
  reclaimTrigger: "0x0000000000000000000000000000000000000707",
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  maxChannelsPerRun: 8,
  gasBase: "200000",
  gasPerChannel: "80000",
};

function listing(channelIds: Hex[]) {
  HttpActionsMock.testInstance().sendRequest = () => ({
    statusCode: 200,
    body: Buffer.from(
      JSON.stringify({
        eventId: config.eventId,
        vault: config.vault,
        channels: channelIds.map((channelId) => ({ channelId })),
      }),
    ).toString("base64"),
  });
}

function channelConfig(channelId: Hex, submitUntil: number) {
  return encodeFunctionResult({
    abi: vaultAbi,
    functionName: "channelConfig",
    result: {
      channelId,
      eventId: channelId === zeroHash ? zeroHash : (config.eventId as Hex),
      asset: "0x0000000000000000000000000000000000000303",
      reserveUnits: channelId === zeroHash ? 0n : 1_000_000n,
      vendorId: zeroHash,
      vendorDestinationVersion: 1n,
      terminalInstanceId: zeroHash,
      terminalKeyVersion: 1n,
      attendeeChannelSigner: "0x0000000000000000000000000000000000000404",
      configVersion: 1n,
      organizerFeeBps: 0,
      platformFeeBps: 0,
      maxPerVoucher: 1n,
      maxVoucherCount: 1,
      acceptFrom: 0,
      acceptUntil: 0,
      submitUntil,
      genesisDigest: zeroHash,
    },
  });
}

const channelState = encodeFunctionResult({
  abi: vaultAbi,
  functionName: "channelState",
  result: ["0x0000000000000000000000000000000000000505", 0n, 1, zeroHash, false],
});

describe("reserve return workflow", () => {
  test("returns only the listed reserves the finalized chain shows as due", () => {
    listing([unknown, due]);
    const evm = EvmMock.testInstance(MONAD_TESTNET);
    evm.callContract = (request) => {
      const { args } = decodeFunctionData({
        abi: multicallAbi,
        data: bytesToHex(request.call?.data ?? new Uint8Array()),
      });
      const calls = (args?.[0] ?? []) as readonly { callData: Hex }[];
      const ordered = [due, unknown].sort();
      const answers = calls.map((_, index) => {
        if (index === 0)
          return encodeFunctionResult({
            abi: multicallAbi,
            functionName: "getCurrentBlockTimestamp",
            result: 2_000n,
          });
        const channelId = ordered[Math.floor((index - 1) / 2)];
        if (index % 2 === 0) return channelState;
        return channelId === due ? channelConfig(due, 1_500) : channelConfig(zeroHash, 0);
      });
      return {
        data: hexToBase64(
          encodeFunctionResult({
            abi: multicallAbi,
            functionName: "aggregate3",
            result: answers.map((returnData) => ({ success: true, returnData })),
          }),
        ),
      };
    };
    let gasLimit = 0n;
    evm.writeReport = (request) => {
      gasLimit = request.gasConfig?.gasLimit ?? 0n;
      return { txStatus: "TX_STATUS_SUCCESS", txHash: hexToBase64(zeroHash) };
    };
    const result = onCronTrigger(newTestRuntime(null, {}, config) as never);
    expect(result).toContain("Returned 1 reserve(s)");
    expect(gasLimit).toBe(280_000n);
  });

  test("skips the chain entirely when nothing is due", () => {
    listing([]);
    const evm = EvmMock.testInstance(MONAD_TESTNET);
    evm.callContract = () => {
      throw new Error("must not read the chain");
    };
    expect(onCronTrigger(newTestRuntime(null, {}, config) as never)).toBe(
      "No reserves are due for return.",
    );
  });
});
