import { readFile, writeFile } from "node:fs/promises";
import {
  accountAbi,
  encodeOfflineVoucher,
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
import { resolveChainFor } from "./account-scenario.js";
import { loadArtifact } from "./artifacts.js";
import { VirtualAuthenticator, type VirtualAuthenticatorState } from "./authenticator.js";

const OPEN_CHANNEL = keccak256(stringToHex("OPEN_CHANNEL"));
const vaultAbi = parseAbi([
  "function channelTermsHash((bytes32 channelId,bytes32 eventId,address asset,uint256 reserveUnits,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,uint256 terminalKeyVersion,address attendeeChannelSigner,uint256 configVersion,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 maxPerVoucher,uint32 maxVoucherCount,uint48 acceptFrom,uint48 acceptUntil,uint48 submitUntil,bytes32 genesisDigest) config,address originalAccount) view returns (bytes32)",
  "function voucherDigest((uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion) voucher) view returns (bytes32)",
  "function reservedFor(address originalAccount) view returns (uint256)",
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
  /** Origin the services validate WebAuthn assertions against. */
  origin?: string;
  /**
   * Distinguishes one run's channel, payment, refund and order identifiers from another's. A local
   * run gets a fresh database and chain each time, so fixed labels are reproducible there; a public
   * chain keeps every channel ever opened, and reusing an identifier would collide with that history
   * rather than test anything.
   */
  runId?: string;
  /**
   * How to reach a deadline. `evm` tells a development chain to jump, which keeps the local suite
   * fast. `chain` waits for real elapsed time, which is the only option on a public network: these
   * deadlines are evaluated against `block.timestamp`, so passing one cannot be simulated.
   */
  timeControl?: "evm" | "chain";
  /**
   * Seconds from now for the channel's acceptance start, acceptance end and submission end. Defaults
   * suit a development chain that can jump. On a public network these become real waiting, so they
   * are set as short as the event's registered bounds permit.
   */
  windows?: { acceptFromSeconds: number; acceptUntilSeconds: number; submitUntilSeconds: number };
  /**
   * Registry records to use instead of registering new ones. Config, vendor, destination and terminal
   * registration are `onlyOrganizer` calls, so a deployed event is provisioned by the organizer out of
   * band and this scenario is not the organizer. Supplying them also keeps the harness from holding
   * the organizer's key.
   */
  provisioned?: {
    vendorId: Hex;
    terminalId: Hex;
    configVersion: bigint;
    destinationVersion: bigint;
    organizerFeeBps: number;
    platformFeeBps: number;
  };
  /**
   * Stop once the reserve channel is open and finalized, leaving it untouched. An untouched channel
   * is what a physical terminal installs during provisioning; settling, reclaiming or refunding it
   * here would disqualify it from that.
   */
  stopAfterReserveOpen?: boolean;
};

export type TreasuryScenarioResult =
  | {
      kind: "treasury";
      channelId: Hex;
      paymentId: Hex;
      reclaimState: string;
      withdrawalState: string;
      refundState: string;
    }
  | {
      kind: "treasury-reserve-open";
      channelId: Hex;
      runId: string;
      channelSigner: Address;
      reserveUnits: string;
      acceptFrom: number;
      acceptUntil: number;
      submitUntil: number;
    };

type JourneyState = {
  account: Address;
  enrollmentId: string;
  authenticator: VirtualAuthenticatorState;
};

/**
 * `fetch` that waits out the services' per-client rate limit and cold starts. The limiter rejects a request before
 * any handler runs, so a 429 means nothing was executed and repeating it is safe for any method.
 * A journey against a public chain waits minutes for finality and polls throughout, which is enough
 * to exhaust a per-minute budget without anything being wrong.
 */
async function pacedFetch(input: string, init: RequestInit, attempt = 0): Promise<Response> {
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
  // A 503 is the platform refusing a request an instance was not ready for (a scale-from-zero cold
  // start); like a 429 it never reached a handler. Every write here also carries an idempotency key.
  if ((response.status !== 429 && response.status !== 503) || attempt >= 5) return response;
  const seconds = Number(response.headers.get("retry-after"));
  const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 10;
  await new Promise((resolve) => setTimeout(resolve, wait * 1_000));
  return pacedFetch(input, init, attempt + 1);
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  origin: string,
) {
  const response = await pacedFetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status !== 202)
    throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload as { operationId?: string; state?: string };
}

/**
 * Advances until the chain's own clock has reached `target`.
 *
 * On a development chain the clock is told to jump, so the local suite stays fast. On a public chain
 * there is no such control and no substitute for waiting: eligibility is a contract rule evaluated
 * against `block.timestamp`, so a deadline is reached when it is actually reached. Polling reads the
 * chain rather than the local clock because the two drift, and it is the chain's view that decides.
 */
async function advanceToChainTime(
  publicClient: { getBlock: () => Promise<{ timestamp: bigint }>; request: unknown },
  target: number,
  mode: "evm" | "chain",
) {
  const chainSeconds = async () => Number((await publicClient.getBlock()).timestamp);
  if (mode === "evm") {
    const current = await chainSeconds();
    const request = publicClient.request as (args: unknown) => Promise<unknown>;
    if (target > current)
      await request({ method: "evm_increaseTime", params: [target - current + 1] });
    await request({ method: "evm_mine", params: [] });
    return;
  }
  for (;;) {
    const current = await chainSeconds();
    if (current >= target) return;
    // Sleep no longer than the remaining gap, so the wait ends promptly once the deadline passes.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(5_000, (target - current) * 1_000)),
    );
  }
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
  origin: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await post(url, path, body, headers, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("channel_not_found") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/**
 * Polls a vendor treasury operation until the relayer reports it finalized.
 *
 * Acceptance is not execution: the relayer queues the operation and a later step may depend on the
 * balance this one moves, so ordering them requires waiting for the finalized state rather than for
 * the 202.
 */
async function awaitOperation(
  relayerUrl: string,
  collection: "financial-operations" | "vendor-financial-operations",
  operationId: string,
  token: string,
  origin: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await pacedFetch(`${relayerUrl}/v1/${collection}/${operationId}`, {
      headers: { authorization: `Bearer ${token}`, origin },
    });
    const body = (await response.json().catch(() => ({}))) as { state?: string };
    if (!response.ok)
      throw new Error(`operation ${operationId} read failed with ${response.status}`);
    if (body.state === "FINALIZED") return body.state;
    if (body.state === "FAILED" || body.state === "EXPIRED" || body.state === "QUARANTINED")
      throw new Error(`operation ${operationId} ended in ${body.state}`);
    if (Date.now() >= deadline)
      throw new Error(`operation ${operationId} still ${body.state} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
}

/** Polls a channel's public reserve-return status until it is finalized. */
async function awaitReserveReturn(
  relayerUrl: string,
  channelId: Hex,
  origin: string,
  timeoutMs = 180_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await pacedFetch(`${relayerUrl}/v1/reserve-channels/${channelId}/reclaims`, {
      headers: { origin },
    });
    const body = (await response.json().catch(() => ({}))) as { state?: string };
    if (!response.ok) throw new Error(`reserve return read failed with ${response.status}`);
    if (body.state === "FINALIZED") return body.state;
    if (body.state === "FAILED" || body.state === "QUARANTINED")
      throw new Error(`reserve return for ${channelId} ended in ${body.state}`);
    if (Date.now() >= deadline)
      throw new Error(`reserve return for ${channelId} still ${body.state} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
}

/**
 * Drives the vendor and attendee money operations through the running relayer, every one of them
 * sponsored: opens a reserve channel from the enrolled account, settles a dual-signed voucher to
 * create vendor credit, then exercises reclaim, a vendor-signed refund and a fixed-destination
 * withdrawal. The deployer wallet only provisions registry terms when none are supplied.
 */
export async function runTreasuryScenario(
  options: TreasuryScenarioOptions,
): Promise<TreasuryScenarioResult> {
  const state = JSON.parse(await readFile(options.statePath, "utf8")) as JourneyState;
  const authenticator = VirtualAuthenticator.restore(state.authenticator);
  // Each assertion advances the signature counter the service records, so the state file is written
  // after every one; a run that failed later would otherwise leave every restore refused as a replay.
  const persist = () =>
    writeFile(
      options.statePath,
      JSON.stringify({ ...state, authenticator: authenticator.toJSON() }),
      "utf8",
    );
  const chain = await resolveChainFor(options.rpcUrl);
  const origin = options.origin ?? "http://localhost:3000";
  const runId = options.runId ?? "treasury";
  const timeControl = options.timeControl ?? "evm";
  const deployer = privateKeyToAccount(options.deployerPrivateKey);
  const vendorAuthority = privateKeyToAccount(options.vendorAuthorityPrivateKey);
  const terminalSigner = privateKeyToAccount(options.terminalPrivateKey);
  // Scoped to the run, because the channel signer is bound into the channel's immutable terms: a
  // shared signer across runs would let one run's authorization satisfy another run's channel.
  const channelSigner = privateKeyToAccount(keccak256(stringToHex(`channel-signer:${runId}`)));
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: deployer });
  const { registry, vault, router, token, eventId } = options.event;

  const registryArtifact = loadArtifact("EventRegistry.sol", "EventRegistry");
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
  const vendorId = options.provisioned?.vendorId ?? b32("vendor:treasury");
  const terminalId = options.provisioned?.terminalId ?? b32("terminal:treasury");
  const configVersion = options.provisioned?.configVersion ?? 1n;
  const destinationVersion = options.provisioned?.destinationVersion ?? 1n;
  const organizerFeeBps = options.provisioned?.organizerFeeBps ?? 200;
  const platformFeeBps = options.provisioned?.platformFeeBps ?? 100;
  if (!options.provisioned) {
    await provisionRegistry();
  }

  async function provisionRegistry() {
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
  }

  const reserveUnits = 2_000_000n;
  const grossUnits = 1_000_000n;
  const channelId = b32(`channel:${runId}`);
  const acceptFrom = now + (options.windows?.acceptFromSeconds ?? 60);
  const acceptUntil = now + (options.windows?.acceptUntilSeconds ?? 3_600);
  const submitUntil = now + (options.windows?.submitUntilSeconds ?? 7_200);
  const channelConfig = {
    channelId,
    eventId,
    asset: token,
    reserveUnits,
    vendorId,
    vendorDestinationVersion: destinationVersion,
    terminalInstanceId: terminalId,
    terminalKeyVersion: 1n,
    attendeeChannelSigner: channelSigner.address,
    configVersion,
    organizerFeeBps,
    platformFeeBps,
    maxPerVoucher: 1_000_000n,
    maxVoucherCount: 10,
    acceptFrom,
    acceptUntil,
    submitUntil,
    genesisDigest: b32(`genesis:${runId}`),
  };
  const termsHash = (await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "channelTermsHash",
    args: [channelConfig, state.account],
  })) as Hex;
  // The account caps its total reserved balance, so the cap must cover channels it already holds
  // (including expired ones not yet reclaimed) plus this one, or the open reverts.
  const maximumTotalReserve =
    ((await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "reservedFor",
      args: [state.account],
    })) as bigint) + reserveUnits;
  const openTerms = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [vault, channelId, reserveUnits, maximumTotalReserve, termsHash],
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
  await persist();
  const session = await pacedFetch(`${options.apiUrl}/v1/accounts/authentication-challenges`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ account: state.account }),
  }).then(async (response) => {
    const challenge = (await response.json()) as {
      challengeToken: string;
      options: { challenge: string };
    };
    if (!response.ok) throw new Error(`authentication challenge failed: ${response.status}`);
    const verified = await pacedFetch(`${options.apiUrl}/v1/accounts/authentications`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        challengeToken: challenge.challengeToken,
        response: authenticator.authenticationBase64Url(challenge.options.challenge),
      }),
    });
    await persist();
    const body = (await verified.json()) as { sessionToken: string };
    if (!verified.ok) throw new Error(`authentication failed: ${verified.status}`);
    return body.sessionToken;
  });

  // Opened through the sponsored account-command route, so the attendee account holds no gas and
  // the relayer's policy, simulation and finality checks apply exactly as they do for the web app.
  const reserveCalldata = encodeFunctionData({
    abi: accountAbi,
    functionName: "openReserveChannel",
    args: [
      vault,
      channelConfig,
      maximumTotalReserve,
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
  const reserve = await post(
    options.relayerUrl,
    "/v1/accounts/commands",
    { kind: "RESERVE_OPEN", calldata: reserveCalldata },
    {
      authorization: `Bearer ${session}`,
      "idempotency-key": `financial:RESERVE_OPEN:${channelId}`,
    },
    origin,
  );
  if (!reserve.operationId) throw new Error("reserve open was not journaled");
  await awaitOperation(
    options.relayerUrl,
    "financial-operations",
    reserve.operationId,
    session,
    origin,
  );

  if (options.stopAfterReserveOpen) {
    // The channel signer is derived from the run id, so the run id is enough to sign vouchers later;
    // the key itself is never printed.
    return {
      kind: "treasury-reserve-open",
      channelId,
      runId,
      channelSigner: channelSigner.address,
      reserveUnits: reserveUnits.toString(),
      acceptFrom,
      acceptUntil,
      submitUntil,
    };
  }

  // A voucher is only acceptable once the channel's acceptance window has opened.
  await advanceToChainTime(publicClient, acceptFrom + 1, timeControl);

  const paymentId = b32(`payment:${runId}:1`);
  const voucher = {
    protocolVersion: 1,
    chainId: BigInt(chain.id),
    vault,
    channelId,
    sequence: 1,
    previousVoucherDigest: channelConfig.genesisDigest,
    paymentId,
    orderRefHash: b32(`order:${runId}:1`),
    grossUnits,
    cumulativeGrossUnits: grossUnits,
    receiptCommitment: b32(`receipt:${runId}:1`),
    acceptedAt: acceptFrom,
    acceptUntil,
    submitUntil,
    configVersion,
  };
  const voucherDigest = (await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "voucherDigest",
    args: [voucher],
  })) as Hex;
  // Submitted through the vendor treasury's sponsored route. The vault checks both signatures, so
  // the relayer only pays gas; it waits out the indexer's projection of the freshly opened channel.
  const settlement = await postAwaitingProjection(
    options.relayerUrl,
    `/v1/reserve-channels/${channelId}/vouchers`,
    {
      voucher: encodeOfflineVoucher(voucher),
      attendeeSignature: await channelSigner.sign({ hash: voucherDigest }),
      terminalSignature: await terminalSigner.sign({ hash: voucherDigest }),
    },
    {
      authorization: `Bearer ${options.vendorTreasuryToken}`,
      "idempotency-key": `voucher:${paymentId}`,
    },
    origin,
  );
  if (!settlement.operationId) throw new Error("voucher settlement was not journaled");
  await awaitOperation(
    options.relayerUrl,
    "vendor-financial-operations",
    settlement.operationId,
    options.vendorTreasuryToken,
    origin,
  );

  // Reclaim is only eligible once the merchant submission window has closed (§10.8), so this waits
  // past `submitUntil` rather than asking the service to relax the rule.
  await advanceToChainTime(publicClient, submitUntil + 1, timeControl);

  // Sent with no session or credential: the return is public because the vault pays only the
  // original account, which is what makes it safe for anyone, including a scheduler, to trigger.
  const reclaim = await postAwaitingProjection(
    options.relayerUrl,
    `/v1/reserve-channels/${channelId}/reclaims`,
    { eventId },
    {},
    origin,
  );

  // A settled voucher credits the vendor with the gross less the organizer and platform fees, so the
  // vendor's own credit — the only balance a credit-backed refund may draw on — is the net, not the
  // gross. Refunding part of it leaves the rest for the withdrawal to pay out, so one run exercises
  // both claims on the same credit.
  const vendorCreditUnits =
    grossUnits -
    (grossUnits * BigInt(organizerFeeBps)) / 10_000n -
    (grossUnits * BigInt(platformFeeBps)) / 10_000n;
  const refundUnits = vendorCreditUnits / 2n;

  const refundIntent: RefundIntent = {
    schemaVersion: 1,
    chainId: BigInt(chain.id),
    router,
    eventId,
    refundId: b32(`refund:${runId}:1`),
    paymentId,
    payerAccount: state.account,
    vendorId,
    asset: token,
    refundUnits,
    cumulativeRefundUnits: refundUnits,
    // Funded entirely from the vendor's settled credit, so the refund needs no external transfer.
    vendorCreditUnits: refundUnits,
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
    origin,
  );
  const refundState = refund.operationId
    ? await awaitOperation(
        options.relayerUrl,
        "vendor-financial-operations",
        refund.operationId,
        options.vendorTreasuryToken,
        origin,
      )
    : (refund.state ?? "ACCEPTED");

  // Last, because a withdrawal pays out the vendor's whole remaining credit: running it first would
  // leave nothing for a credit-backed refund to draw on.
  const withdrawal = await post(
    options.relayerUrl,
    `/v1/vendors/${vendorId}/withdrawals`,
    { destinationVersion: destinationVersion.toString() },
    {
      authorization: `Bearer ${options.vendorTreasuryToken}`,
      "idempotency-key": `withdraw:${vendorId}:${runId}`,
    },
    origin,
  );

  return {
    kind: "treasury",
    channelId,
    paymentId,
    reclaimState: reclaim.operationId
      ? await awaitReserveReturn(options.relayerUrl, channelId, origin)
      : (reclaim.state ?? "ACCEPTED"),
    withdrawalState: withdrawal.operationId
      ? await awaitOperation(
          options.relayerUrl,
          "vendor-financial-operations",
          withdrawal.operationId,
          options.vendorTreasuryToken,
          origin,
        )
      : (withdrawal.state ?? "ACCEPTED"),
    refundState,
  };
}
