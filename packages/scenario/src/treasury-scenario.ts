import { readFile } from "node:fs/promises";
import {
  accountAbi,
  exactPayRouterAbi,
  type RefundIntent,
  refundIntentDigest,
} from "@openbalance/protocol";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor } from "./account-scenario.js";
import { loadArtifact } from "./artifacts.js";
import { VirtualAuthenticator, type VirtualAuthenticatorState } from "./authenticator.js";

const OPEN_CHANNEL = keccak256(stringToHex("OPEN_CHANNEL"));
const vaultAbi = parseAbi([
  "function channelTermsHash((bytes32 channelId,bytes32 eventId,address asset,uint256 reserveUnits,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,uint256 terminalKeyVersion,address attendeeChannelSigner,uint256 configVersion,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 maxPerVoucher,uint32 maxVoucherCount,uint48 acceptFrom,uint48 acceptUntil,uint48 submitUntil,bytes32 genesisDigest) config,address originalAccount) view returns (bytes32)",
  "function voucherDigest((uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion) voucher) view returns (bytes32)",
]);
const registryReads = parseAbi([
  "function destinationDigest(bytes32 vendorId,uint256 version,address destination,uint256 deadline) view returns (bytes32)",
]);
const b32 = (label: string) => keccak256(stringToHex(label));

export type TreasuryScenarioOptions = {
  rpcUrl: string;
  deployerPrivateKey: Hex;
  apiUrl: string;
  relayerUrl: string;
  statePath: string;
  vendorTreasuryToken: string;
  vendorAuthorityPrivateKey: Hex;
  terminalPrivateKey: Hex;
  event: {
    eventId: Hex;
    registry: Address;
    router: Address;
    vault: Address;
    ledger: Address;
    token: Address;
  };
};

export type TreasuryScenarioResult = {
  kind: "treasury";
  channelId: Hex;
  paymentId: Hex;
  reclaimState: string;
  withdrawalState: string;
  refundState: string;
};

type JourneyState = {
  account: Address;
  enrollmentId: string;
  authenticator: VirtualAuthenticatorState;
};

async function post(url: string, path: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status !== 202)
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload as { operationId?: string; state?: string };
}

/**
 * Retries an idempotent post while the relayer still reports the finalized projection as missing.
 * The indexer projects channel state asynchronously, so a command issued immediately after mining
 * can legitimately observe a not-yet-projected channel. This waits for projection convergence
 * rather than treating the race as a failure; any other rejection is raised immediately.
 */
async function postAwaitingProjection(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await post(url, path, body, headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("channel_not_found") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/**
 * Drives the vendor and attendee money operations through the running relayer: opens a reserve
 * channel from the enrolled account, settles a voucher to create vendor credit, then exercises
 * permissionless reclaim, a fixed-destination withdrawal and a vendor-signed refund.
 */
export async function runTreasuryScenario(
  options: TreasuryScenarioOptions,
): Promise<TreasuryScenarioResult> {
  const state = JSON.parse(await readFile(options.statePath, "utf8")) as JourneyState;
  const authenticator = VirtualAuthenticator.restore(state.authenticator);
  const chain = chainFor(options.rpcUrl);
  const deployer = privateKeyToAccount(options.deployerPrivateKey);
  const vendorAuthority = privateKeyToAccount(options.vendorAuthorityPrivateKey);
  const terminalSigner = privateKeyToAccount(options.terminalPrivateKey);
  const channelSigner = privateKeyToAccount(keccak256(stringToHex("treasury:channel")));
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: deployer });
  const { registry, vault, router, token, eventId } = options.event;

  const registryArtifact = loadArtifact("EventRegistry.sol", "EventRegistry");
  const vaultArtifact = loadArtifact("ResilienceVault.sol", "ResilienceVault");
  const send = async (call: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => {
    const hash = await wallet.writeContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      account: deployer as Account,
      chain: chain as Chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${call.functionName} reverted`);
  };

  const now = Number((await publicClient.getBlock()).timestamp);
  const vendorId = b32("vendor:treasury");
  const terminalId = b32("terminal:treasury");
  await send({
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerConfig",
    args: [
      1n,
      {
        validAfter: now,
        validUntil: now + 86_400,
        organizerFeeBps: 200,
        platformFeeBps: 100,
        maximumAcceptanceDuration: 3_600,
        maximumSubmissionDelay: 3_600,
        organizerDestination: deployer.address,
        platformDestination: deployer.address,
        termsHash: b32("terms:treasury"),
        enabled: true,
      },
    ],
  });
  await send({
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerVendor",
    args: [vendorId, vendorAuthority.address],
  });
  const destinationDeadline = BigInt(now + 3_600);
  const destinationDigest = (await publicClient.readContract({
    address: registry,
    abi: registryReads,
    functionName: "destinationDigest",
    args: [vendorId, 1n, deployer.address, destinationDeadline],
  })) as Hex;
  await send({
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerDestination",
    args: [
      vendorId,
      1n,
      deployer.address,
      destinationDeadline,
      await vendorAuthority.sign({ hash: destinationDigest }),
    ],
  });
  await send({
    address: registry,
    abi: registryArtifact.abi,
    functionName: "registerTerminal",
    args: [terminalId, 1n, vendorId, terminalSigner.address, now, now + 86_400],
  });

  const reserveUnits = 2_000_000n;
  const grossUnits = 1_000_000n;
  const channelId = b32("channel:treasury");
  const acceptFrom = now + 60;
  const acceptUntil = now + 3_600;
  const submitUntil = now + 7_200;
  const channelConfig = {
    channelId,
    eventId,
    asset: token,
    reserveUnits,
    vendorId,
    vendorDestinationVersion: 1n,
    terminalInstanceId: terminalId,
    terminalKeyVersion: 1n,
    attendeeChannelSigner: channelSigner.address,
    configVersion: 1n,
    organizerFeeBps: 200,
    platformFeeBps: 100,
    maxPerVoucher: 1_000_000n,
    maxVoucherCount: 10,
    acceptFrom,
    acceptUntil,
    submitUntil,
    genesisDigest: b32("genesis:treasury"),
  };
  const termsHash = (await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "channelTermsHash",
    args: [channelConfig, state.account],
  })) as Hex;
  const openTerms = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [vault, channelId, reserveUnits, reserveUnits, termsHash],
    ),
  );
  const openDeadline = BigInt(now + 3_600);
  const openDigest = (await publicClient.readContract({
    address: state.account,
    abi: accountAbi,
    functionName: "commandDigest",
    args: [OPEN_CHANNEL, openTerms, openDeadline],
  })) as Hex;
  const assertion = authenticator.assert(openDigest);
  await send({
    address: state.account,
    abi: accountAbi,
    functionName: "openReserveChannel",
    args: [
      vault,
      channelConfig,
      reserveUnits,
      openDeadline,
      false,
      {
        r: assertion.r,
        s: assertion.s,
        challengeIndex: assertion.challengeIndex,
        typeIndex: assertion.typeIndex,
        authenticatorData: assertion.authenticatorData,
        clientDataJSON: assertion.clientDataJSON,
      },
    ],
  });

  await publicClient.request({ method: "evm_increaseTime", params: [90] } as never);
  await publicClient.request({ method: "evm_mine", params: [] } as never);

  const paymentId = b32("payment:treasury:1");
  const voucher = {
    protocolVersion: 1,
    chainId: BigInt(chain.id),
    vault,
    channelId,
    sequence: 1,
    previousVoucherDigest: channelConfig.genesisDigest,
    paymentId,
    orderRefHash: b32("order:treasury:1"),
    grossUnits,
    cumulativeGrossUnits: grossUnits,
    receiptCommitment: b32("receipt:treasury:1"),
    acceptedAt: acceptFrom,
    acceptUntil,
    submitUntil,
    configVersion: 1n,
  };
  const voucherDigest = (await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "voucherDigest",
    args: [voucher],
  })) as Hex;
  await send({
    address: vault,
    abi: vaultArtifact.abi,
    functionName: "settleVoucher",
    args: [
      voucher,
      await channelSigner.sign({ hash: voucherDigest }),
      await terminalSigner.sign({ hash: voucherDigest }),
    ],
  });

  await publicClient.request({
    method: "evm_increaseTime",
    params: [submitUntil - Number((await publicClient.getBlock()).timestamp) + 10],
  } as never);
  await publicClient.request({ method: "evm_mine", params: [] } as never);

  const session = await fetch(`${options.apiUrl}/v1/accounts/authentication-challenges`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ account: state.account }),
    signal: AbortSignal.timeout(30_000),
  }).then(async (response) => {
    const challenge = (await response.json()) as {
      challengeToken: string;
      options: { challenge: string };
    };
    if (!response.ok) throw new Error(`authentication challenge failed: ${response.status}`);
    const verified = await fetch(`${options.apiUrl}/v1/accounts/authentications`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        challengeToken: challenge.challengeToken,
        response: authenticator.authenticationBase64Url(challenge.options.challenge),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await verified.json()) as { sessionToken: string };
    if (!verified.ok) throw new Error(`authentication failed: ${verified.status}`);
    return body.sessionToken;
  });

  const reclaim = await postAwaitingProjection(
    options.relayerUrl,
    `/v1/reserve-channels/${channelId}/reclaims`,
    { eventId },
    { authorization: `Bearer ${session}`, "idempotency-key": `reclaim:${channelId}` },
  );

  const withdrawal = await post(
    options.relayerUrl,
    `/v1/vendors/${vendorId}/withdrawals`,
    { destinationVersion: "1" },
    {
      authorization: `Bearer ${options.vendorTreasuryToken}`,
      "idempotency-key": `withdraw:${vendorId}`,
    },
  );

  const refundIntent: RefundIntent = {
    schemaVersion: 1,
    chainId: BigInt(chain.id),
    router,
    eventId,
    refundId: b32("refund:treasury:1"),
    paymentId,
    payerAccount: state.account,
    vendorId,
    asset: token,
    refundUnits: grossUnits,
    cumulativeRefundUnits: grossUnits,
    vendorCreditUnits: grossUnits,
    // The relayer binds the funding source to the vendor treasury authority, so a refund can only
    // be funded by the credential holder that signed it.
    fundingSource: vendorAuthority.address,
    validAfter: Number((await publicClient.getBlock()).timestamp),
    expiresAt: Number((await publicClient.getBlock()).timestamp) + 3_600,
  };
  const refundCalldata = encodeFunctionData({
    abi: exactPayRouterAbi,
    functionName: "refund",
    args: [refundIntent, await vendorAuthority.sign({ hash: refundIntentDigest(refundIntent) })],
  });
  const refund = await post(
    options.relayerUrl,
    `/v1/payments/${paymentId}/refunds`,
    { calldata: refundCalldata },
    {
      authorization: `Bearer ${options.vendorTreasuryToken}`,
      "idempotency-key": `refund:${paymentId}`,
    },
  );

  return {
    kind: "treasury",
    channelId,
    paymentId,
    reclaimState: reclaim.state ?? "ACCEPTED",
    withdrawalState: withdrawal.state ?? "ACCEPTED",
    refundState: refund.state ?? "ACCEPTED",
  };
}
