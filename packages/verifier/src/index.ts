import {
  exactPayRouterAbi,
  type ReserveChannelConfig,
  resilienceVaultAbi,
  settlementLedgerAbi,
  validateReserveChannelConfig,
} from "@openbalance/protocol";
import {
  type Abi,
  type Address,
  type Chain,
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddress,
  keccak256,
  parseAbi,
  type TransactionReceipt,
} from "viem";

const registryReadAbi = parseAbi([
  "function eventId() view returns (bytes32)",
  "function asset() view returns (address)",
  "function historicalTerminalSigner(bytes32 terminalId,uint256 version,bytes32 vendorId) view returns (address)",
  "function destinations(bytes32 vendorId,uint256 version) view returns (address account,bool enabled)",
  "function configs(uint256 version) view returns (uint48 validAfter,uint48 validUntil,uint16 organizerFeeBps,uint16 platformFeeBps,uint48 maximumAcceptanceDuration,uint48 maximumSubmissionDelay,address organizerDestination,address platformDestination,bytes32 termsHash,bool enabled)",
]);
const ledgerReadAbi = parseAbi([
  "function registry() view returns (address)",
  "function asset() view returns (address)",
  "function router() view returns (address)",
  "function vault() view returns (address)",
  "function totalLiability() view returns (uint256)",
]);
const routerReadAbi = parseAbi([
  "function registry() view returns (address)",
  "function ledger() view returns (address)",
  "function asset() view returns (address)",
]);
const vaultReadAbi = parseAbi([
  "function registry() view returns (address)",
  "function ledger() view returns (address)",
  "function asset() view returns (address)",
  "function totalReserved() view returns (uint256)",
]);

export type ContractManifest = { address: Address; runtimeCodeHash: Hex };
export type DeploymentManifest = {
  chainId: number;
  eventId: Hex;
  asset: Address;
  registry: ContractManifest;
  ledger: ContractManifest;
  router: ContractManifest;
  vault: ContractManifest;
};

export interface VerificationReader {
  getChainId(): Promise<number>;
  getBytecode(input: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
  getTransactionReceipt(input: { hash: Hex }): Promise<TransactionReceipt>;
  getBlock(input: { blockTag: "finalized" } | { blockNumber: bigint }): Promise<{
    number: bigint;
    hash: Hex | null;
  }>;
  readContract(input: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber: bigint;
  }): Promise<unknown>;
}

export function createVerificationReader(rpcUrl: string, chain: Chain): VerificationReader {
  const url = new URL(rpcUrl);
  if (
    (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) ||
    url.username ||
    url.password
  )
    throw new VerificationFailed("RPC URL must use HTTPS and contain no embedded credentials");
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
  });
  return {
    getChainId: () => client.getChainId(),
    getBytecode: (input) => client.getBytecode(input),
    getTransactionReceipt: (input) => client.getTransactionReceipt(input),
    getBlock: (input) => client.getBlock(input),
    readContract: (input) =>
      client.readContract(input as Parameters<typeof client.readContract>[0]) as Promise<unknown>,
  };
}

export class VerificationFailed extends Error {}

const zeroAddress = "0x0000000000000000000000000000000000000000";
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;

function sameAddress(actual: unknown, expected: Address, field: string): void {
  if (typeof actual !== "string" || getAddress(actual) !== getAddress(expected))
    throw new VerificationFailed(`${field} mismatch`);
}

function sameValue(actual: unknown, expected: unknown, field: string): void {
  if (typeof expected === "string" && typeof actual === "string") {
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new VerificationFailed(`${field} mismatch`);
    return;
  }
  if (actual !== expected) throw new VerificationFailed(`${field} mismatch`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null)
    throw new VerificationFailed(`${field} is malformed`);
  return value as Record<string, unknown>;
}

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw new VerificationFailed(`${field} is malformed`);
  return getAddress(value);
}

function asBytes32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !bytes32Pattern.test(value))
    throw new VerificationFailed(`${field} is malformed`);
  return value as Hex;
}

function asBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n)
    throw new VerificationFailed(`${field} is malformed`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new VerificationFailed(`${field} is malformed`);
  return number;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new VerificationFailed(`${field} is malformed`);
  return value;
}

function channelConfigFrom(value: unknown): ReserveChannelConfig {
  const config = asRecord(value, "channel config");
  const parsed: ReserveChannelConfig = {
    channelId: asBytes32(config.channelId, "channel ID"),
    eventId: asBytes32(config.eventId, "channel event ID"),
    asset: asAddress(config.asset, "channel asset"),
    reserveUnits: asBigInt(config.reserveUnits, "reserve units"),
    vendorId: asBytes32(config.vendorId, "vendor ID"),
    vendorDestinationVersion: asBigInt(
      config.vendorDestinationVersion,
      "vendor destination version",
    ),
    terminalInstanceId: asBytes32(config.terminalInstanceId, "terminal instance ID"),
    terminalKeyVersion: asBigInt(config.terminalKeyVersion, "terminal key version"),
    attendeeChannelSigner: asAddress(config.attendeeChannelSigner, "attendee channel signer"),
    configVersion: asBigInt(config.configVersion, "config version"),
    organizerFeeBps: asNumber(config.organizerFeeBps, "organizer fee"),
    platformFeeBps: asNumber(config.platformFeeBps, "platform fee"),
    maxPerVoucher: asBigInt(config.maxPerVoucher, "maximum per voucher"),
    maxVoucherCount: asNumber(config.maxVoucherCount, "maximum voucher count"),
    acceptFrom: asNumber(config.acceptFrom, "accept from"),
    acceptUntil: asNumber(config.acceptUntil, "accept until"),
    submitUntil: asNumber(config.submitUntil, "submit until"),
    genesisDigest: asBytes32(config.genesisDigest, "genesis digest"),
  };
  try {
    validateReserveChannelConfig(parsed);
  } catch {
    throw new VerificationFailed("channel config is invalid");
  }
  return parsed;
}

async function read(
  reader: VerificationReader,
  address: Address,
  abi: Abi,
  functionName: string,
  blockNumber: bigint,
  args?: readonly unknown[],
): Promise<unknown> {
  return reader.readContract({
    address,
    abi,
    functionName,
    ...(args ? { args } : {}),
    blockNumber,
  });
}

export async function verifyDeployment(reader: VerificationReader, manifest: DeploymentManifest) {
  const chainId = await reader.getChainId();
  if (chainId !== manifest.chainId) throw new VerificationFailed("chain ID mismatch");
  const finalized = await reader.getBlock({ blockTag: "finalized" });
  if (finalized.hash === null) throw new VerificationFailed("finalized block has no hash");

  for (const [name, contract] of Object.entries({
    registry: manifest.registry,
    ledger: manifest.ledger,
    router: manifest.router,
    vault: manifest.vault,
  })) {
    const code = await reader.getBytecode({
      address: contract.address,
      blockNumber: finalized.number,
    });
    if (!code || code === "0x" || keccak256(code) !== contract.runtimeCodeHash)
      throw new VerificationFailed(`${name} code mismatch`);
  }

  sameValue(
    await read(reader, manifest.registry.address, registryReadAbi, "eventId", finalized.number),
    manifest.eventId,
    "event ID",
  );
  sameAddress(
    await read(reader, manifest.registry.address, registryReadAbi, "asset", finalized.number),
    manifest.asset,
    "registry asset",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "registry", finalized.number),
    manifest.registry.address,
    "ledger registry",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "asset", finalized.number),
    manifest.asset,
    "ledger asset",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "router", finalized.number),
    manifest.router.address,
    "ledger router",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "vault", finalized.number),
    manifest.vault.address,
    "ledger vault",
  );
  for (const [name, contract, abi] of [
    ["router", manifest.router, routerReadAbi],
    ["vault", manifest.vault, vaultReadAbi],
  ] as const) {
    sameAddress(
      await read(reader, contract.address, abi, "registry", finalized.number),
      manifest.registry.address,
      `${name} registry`,
    );
    sameAddress(
      await read(reader, contract.address, abi, "ledger", finalized.number),
      manifest.ledger.address,
      `${name} ledger`,
    );
    sameAddress(
      await read(reader, contract.address, abi, "asset", finalized.number),
      manifest.asset,
      `${name} asset`,
    );
  }
  return { chainId, finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash };
}

export type FinalizedChannelProof = {
  chainId: bigint;
  vault: Address;
  terminalSigner: Address;
  config: ReserveChannelConfig;
  originalAccount: Address;
  recipients: {
    vendor: Address;
    organizer: Address;
    platform: Address;
  };
  finalizedBlockNumber: bigint;
  finalizedBlockHash: Hex;
};

/**
 * Builds the terminal's immutable channel snapshot from one finalized block.
 * Only a newly opened, unspent channel is eligible for first-time installation.
 */
export async function verifyFinalizedChannel(
  reader: VerificationReader,
  manifest: DeploymentManifest,
  channelId: Hex,
): Promise<FinalizedChannelProof> {
  const deployment = await verifyDeployment(reader, manifest);
  const blockNumber = deployment.finalizedBlockNumber;
  const rawConfig = await read(
    reader,
    manifest.vault.address,
    resilienceVaultAbi,
    "channelConfig",
    blockNumber,
    [channelId],
  );
  const config = channelConfigFrom(rawConfig);
  sameValue(config.channelId, channelId, "channel ID");
  sameValue(config.eventId, manifest.eventId, "channel event ID");
  sameAddress(config.asset, manifest.asset, "channel asset");

  const [rawState, rawRecipients, rawTerminalSigner, rawDestination, rawPolicy] = await Promise.all(
    [
      read(reader, manifest.vault.address, resilienceVaultAbi, "channelState", blockNumber, [
        channelId,
      ]),
      read(reader, manifest.vault.address, resilienceVaultAbi, "channelRecipients", blockNumber, [
        channelId,
      ]),
      read(
        reader,
        manifest.registry.address,
        registryReadAbi,
        "historicalTerminalSigner",
        blockNumber,
        [config.terminalInstanceId, config.terminalKeyVersion, config.vendorId],
      ),
      read(reader, manifest.registry.address, registryReadAbi, "destinations", blockNumber, [
        config.vendorId,
        config.vendorDestinationVersion,
      ]),
      read(reader, manifest.registry.address, registryReadAbi, "configs", blockNumber, [
        config.configVersion,
      ]),
    ],
  );

  const state = asRecord(rawState, "channel state");
  const originalAccount = asAddress(state.originalAccount, "original account");
  if (originalAccount === zeroAddress) throw new VerificationFailed("channel is not opened");
  sameValue(asBigInt(state.spentGross, "spent gross"), 0n, "spent gross");
  sameValue(asNumber(state.nextSequence, "next sequence"), 1, "next sequence");
  sameValue(
    asBytes32(state.lastVoucherDigest, "last voucher digest"),
    config.genesisDigest,
    "last voucher digest",
  );
  sameValue(asBoolean(state.reclaimed, "reclaimed"), false, "reclaimed");

  const recipients = asRecord(rawRecipients, "channel recipients");
  const vendor = asAddress(recipients.vendor, "vendor recipient");
  const organizer = asAddress(recipients.organizer, "organizer recipient");
  const platform = asAddress(recipients.platform, "platform recipient");
  if (vendor === zeroAddress || organizer === zeroAddress || platform === zeroAddress)
    throw new VerificationFailed("channel recipient is unavailable");

  const terminalSigner = asAddress(rawTerminalSigner, "terminal signer");
  if (terminalSigner === zeroAddress)
    throw new VerificationFailed("terminal signer is unavailable");

  const destination = asRecord(rawDestination, "vendor destination");
  sameAddress(destination.account, vendor, "vendor recipient");

  const policy = asRecord(rawPolicy, "event config");
  sameValue(
    asNumber(policy.organizerFeeBps, "registered organizer fee"),
    config.organizerFeeBps,
    "organizer fee",
  );
  sameValue(
    asNumber(policy.platformFeeBps, "registered platform fee"),
    config.platformFeeBps,
    "platform fee",
  );
  sameAddress(policy.organizerDestination, organizer, "organizer recipient");
  sameAddress(policy.platformDestination, platform, "platform recipient");

  const validAfter = asNumber(policy.validAfter, "config valid after");
  const validUntil = asNumber(policy.validUntil, "config valid until");
  const maximumAcceptanceDuration = asNumber(
    policy.maximumAcceptanceDuration,
    "maximum acceptance duration",
  );
  const maximumSubmissionDelay = asNumber(
    policy.maximumSubmissionDelay,
    "maximum submission delay",
  );
  if (
    config.acceptFrom < validAfter ||
    config.acceptUntil > validUntil ||
    config.acceptUntil - config.acceptFrom > maximumAcceptanceDuration ||
    config.submitUntil - config.acceptUntil > maximumSubmissionDelay
  )
    throw new VerificationFailed("channel window exceeds registered policy");

  return {
    chainId: BigInt(deployment.chainId),
    vault: getAddress(manifest.vault.address),
    terminalSigner,
    config,
    originalAccount,
    recipients: { vendor, organizer, platform },
    finalizedBlockNumber: blockNumber,
    finalizedBlockHash: deployment.finalizedBlockHash,
  };
}

export type ExpectedTransition =
  | {
      kind: "payment";
      contract: Address;
      transactionHash: Hex;
      paymentId: Hex;
      payer: Address;
      vendorId: Hex;
      gross: bigint;
    }
  | {
      kind: "refund";
      contract: Address;
      transactionHash: Hex;
      refundId: Hex;
      paymentId: Hex;
      payer: Address;
      amount: bigint;
    }
  | {
      kind: "voucher";
      contract: Address;
      transactionHash: Hex;
      channelId: Hex;
      paymentId: Hex;
      sequence: number;
      grossUnits: bigint;
      cumulativeGrossUnits: bigint;
    }
  | {
      kind: "reclaim";
      contract: Address;
      transactionHash: Hex;
      channelId: Hex;
      originalAccount: Address;
      returnedUnits: bigint;
    }
  | {
      kind: "withdrawal";
      contract: Address;
      transactionHash: Hex;
      beneficiaryId: Hex;
      destination: Address;
      amount: bigint;
    };

const transitionDefinition = {
  payment: { abi: exactPayRouterAbi, event: "PaymentCommitted" },
  refund: { abi: exactPayRouterAbi, event: "RefundCommitted" },
  voucher: { abi: resilienceVaultAbi, event: "VoucherSettled" },
  reclaim: { abi: resilienceVaultAbi, event: "ChannelReclaimed" },
  withdrawal: { abi: settlementLedgerAbi, event: "Withdrawn" },
} as const;

export async function verifyFinalizedTransition(
  reader: VerificationReader,
  expected: ExpectedTransition,
) {
  const receipt = await reader.getTransactionReceipt({ hash: expected.transactionHash });
  sameValue(receipt.transactionHash, expected.transactionHash, "transaction hash");
  if (receipt.status !== "success") throw new VerificationFailed("transaction reverted");
  const finalized = await reader.getBlock({ blockTag: "finalized" });
  if (receipt.blockNumber > finalized.number)
    throw new VerificationFailed("transaction is not finalized");
  const canonical = await reader.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash === null || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
    throw new VerificationFailed("transaction block is not canonical");

  const definition = transitionDefinition[expected.kind];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(expected.contract)) continue;
    try {
      const decoded = decodeEventLog({ abi: definition.abi, data: log.data, topics: log.topics });
      if (decoded.eventName !== definition.event) continue;
      const args = decoded.args as Record<string, unknown>;
      for (const [field, value] of Object.entries(expected)) {
        if (field === "kind" || field === "contract" || field === "transactionHash") continue;
        sameValue(args[field], value, field);
      }
      return {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        logIndex: log.logIndex,
        finalizedHead: finalized.number,
      };
    } catch (error) {
      if (error instanceof VerificationFailed) throw error;
    }
  }
  throw new VerificationFailed(`${definition.event} event not found`);
}

export async function verifyCustodyConservation(
  reader: VerificationReader,
  manifest: DeploymentManifest,
) {
  const finalized = await reader.getBlock({ blockTag: "finalized" });
  if (finalized.hash === null) throw new VerificationFailed("finalized block has no hash");
  const [ledgerBalance, ledgerLiability, vaultBalance, vaultLiability] = await Promise.all([
    read(reader, manifest.asset, erc20Abi, "balanceOf", finalized.number, [
      manifest.ledger.address,
    ]),
    read(reader, manifest.ledger.address, ledgerReadAbi, "totalLiability", finalized.number),
    read(reader, manifest.asset, erc20Abi, "balanceOf", finalized.number, [manifest.vault.address]),
    read(reader, manifest.vault.address, vaultReadAbi, "totalReserved", finalized.number),
  ]);
  sameValue(ledgerBalance, ledgerLiability, "ledger custody");
  sameValue(vaultBalance, vaultLiability, "vault custody");
  return { ledgerUnits: ledgerBalance as bigint, vaultUnits: vaultBalance as bigint };
}
