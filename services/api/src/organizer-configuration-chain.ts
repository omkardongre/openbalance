import { eventRegistryAbi } from "@openbalance/protocol";
import {
  type Address,
  createPublicClient,
  decodeEventLog,
  getAddress,
  type Hex,
  http,
  type PublicClient,
} from "viem";
import type { CheckoutEventPolicy } from "./checkout-manifest.js";

export type OrganizerEventPolicy = CheckoutEventPolicy & { chainId: number };

export type OrganizerCommandKind = "CONFIG" | "VENDOR" | "DESTINATION" | "TERMINAL";

export type PreparedOrganizerCommand = {
  kind: OrganizerCommandKind;
  aggregateId: string;
  calldata: Hex;
};

export type OrganizerCheckpoint = {
  organizer: Address;
  blockNumber: bigint;
  blockHash: Hex;
};

export type OrganizerFinality = {
  blockNumber: bigint;
  blockHash: Hex;
};

export type OrganizerConfigurationChain = {
  prepare(
    event: OrganizerEventPolicy,
    command: PreparedOrganizerCommand,
  ): Promise<OrganizerCheckpoint>;
  confirm(
    event: OrganizerEventPolicy,
    command: PreparedOrganizerCommand,
    organizer: Address,
    transactionHash: Hex,
  ): Promise<OrganizerFinality | null>;
};

export class OrganizerConfigurationMismatch extends Error {}

const expectedEvent: Record<OrganizerCommandKind, string> = {
  CONFIG: "ConfigRegistered",
  VENDOR: "VendorRegistered",
  DESTINATION: "DestinationRegistered",
  TERMINAL: "TerminalRegistered",
};

export class ViemOrganizerConfigurationChain implements OrganizerConfigurationChain {
  readonly #client: PublicClient;

  constructor(rpcUrl: string) {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))
      throw new Error("Organizer RPC transport must use HTTPS");
    this.#client = createPublicClient({
      transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
    });
  }

  async prepare(
    event: OrganizerEventPolicy,
    command: PreparedOrganizerCommand,
  ): Promise<OrganizerCheckpoint> {
    const block = await this.#client.getBlock({ blockTag: "finalized" });
    const blockNumber = block.number;
    const [chainId, eventId, asset, organizer] = await Promise.all([
      this.#client.getChainId(),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "eventId",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "asset",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "organizer",
        blockNumber,
      }),
    ]);
    if (
      chainId !== event.chainId ||
      eventId.toLowerCase() !== event.eventId ||
      getAddress(asset) !== event.asset ||
      !block.hash
    )
      throw new OrganizerConfigurationMismatch("Finalized registry identity does not match policy");
    try {
      await this.#client.call({
        account: getAddress(organizer),
        to: event.registry,
        data: command.calldata,
        blockNumber,
      });
    } catch {
      throw new OrganizerConfigurationMismatch("Organizer command is not valid at finalized state");
    }
    return { organizer: getAddress(organizer), blockNumber, blockHash: block.hash };
  }

  async confirm(
    event: OrganizerEventPolicy,
    command: PreparedOrganizerCommand,
    organizer: Address,
    transactionHash: Hex,
  ): Promise<OrganizerFinality | null> {
    const observation = await Promise.all([
      this.#client.getTransactionReceipt({ hash: transactionHash }),
      this.#client.getTransaction({ hash: transactionHash }),
    ]).catch(() => null);
    if (!observation) return null;
    const [receipt, transaction] = observation;
    const finalized = await this.#client.getBlock({ blockTag: "finalized" });
    if (receipt.blockNumber > finalized.number) return null;
    const block = await this.#client.getBlock({ blockNumber: receipt.blockNumber });
    if (
      receipt.status !== "success" ||
      !transaction.to ||
      getAddress(transaction.from) !== organizer ||
      getAddress(transaction.to) !== event.registry ||
      transaction.input.toLowerCase() !== command.calldata.toLowerCase() ||
      transaction.blockHash !== receipt.blockHash ||
      block.hash !== receipt.blockHash
    )
      throw new OrganizerConfigurationMismatch("Finalized transaction does not match command");

    const emitted = receipt.logs.some((log) => {
      if (getAddress(log.address) !== event.registry) return false;
      try {
        return (
          decodeEventLog({ abi: eventRegistryAbi, data: log.data, topics: log.topics })
            .eventName === expectedEvent[command.kind]
        );
      } catch {
        return false;
      }
    });
    if (!emitted)
      throw new OrganizerConfigurationMismatch("Expected registry event is absent from receipt");
    return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
  }
}
