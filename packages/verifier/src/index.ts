import { exactPayRouterAbi, resilienceVaultAbi, settlementLedgerAbi } from "@openbalance/protocol";
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
  keccak256,
  parseAbi,
  type TransactionReceipt,
} from "viem";

const registryReadAbi = parseAbi([
  "function eventId() view returns (bytes32)",
  "function asset() view returns (address)",
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
  getBytecode(input: { address: Address; blockTag: "finalized" }): Promise<Hex | undefined>;
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
    blockTag: "finalized";
  }): Promise<unknown>;
}

export function createVerificationReader(rpcUrl: string, chain: Chain): VerificationReader {
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

async function read(
  reader: VerificationReader,
  address: Address,
  abi: Abi,
  functionName: string,
  args?: readonly unknown[],
): Promise<unknown> {
  return reader.readContract({
    address,
    abi,
    functionName,
    ...(args ? { args } : {}),
    blockTag: "finalized",
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
    const code = await reader.getBytecode({ address: contract.address, blockTag: "finalized" });
    if (!code || code === "0x" || keccak256(code) !== contract.runtimeCodeHash)
      throw new VerificationFailed(`${name} code mismatch`);
  }

  sameValue(
    await read(reader, manifest.registry.address, registryReadAbi, "eventId"),
    manifest.eventId,
    "event ID",
  );
  sameAddress(
    await read(reader, manifest.registry.address, registryReadAbi, "asset"),
    manifest.asset,
    "registry asset",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "registry"),
    manifest.registry.address,
    "ledger registry",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "asset"),
    manifest.asset,
    "ledger asset",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "router"),
    manifest.router.address,
    "ledger router",
  );
  sameAddress(
    await read(reader, manifest.ledger.address, ledgerReadAbi, "vault"),
    manifest.vault.address,
    "ledger vault",
  );
  for (const [name, contract, abi] of [
    ["router", manifest.router, routerReadAbi],
    ["vault", manifest.vault, vaultReadAbi],
  ] as const) {
    sameAddress(
      await read(reader, contract.address, abi, "registry"),
      manifest.registry.address,
      `${name} registry`,
    );
    sameAddress(
      await read(reader, contract.address, abi, "ledger"),
      manifest.ledger.address,
      `${name} ledger`,
    );
    sameAddress(
      await read(reader, contract.address, abi, "asset"),
      manifest.asset,
      `${name} asset`,
    );
  }
  return { chainId, finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash };
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
  const [ledgerBalance, ledgerLiability, vaultBalance, vaultLiability] = await Promise.all([
    read(reader, manifest.asset, erc20Abi, "balanceOf", [manifest.ledger.address]),
    read(reader, manifest.ledger.address, ledgerReadAbi, "totalLiability"),
    read(reader, manifest.asset, erc20Abi, "balanceOf", [manifest.vault.address]),
    read(reader, manifest.vault.address, vaultReadAbi, "totalReserved"),
  ]);
  sameValue(ledgerBalance, ledgerLiability, "ledger custody");
  sameValue(vaultBalance, vaultLiability, "vault custody");
  return { ledgerUnits: ledgerBalance as bigint, vaultUnits: vaultBalance as bigint };
}
