import { randomUUID } from "node:crypto";
import { eventRegistryAbi } from "@openbalance/protocol";
import type { Pool } from "pg";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
} from "viem";
import type { CheckoutManifest } from "./checkout-manifest.js";
import type { OperationsIdentity } from "./operations-access.js";
import type {
  OrganizerCommandKind,
  OrganizerConfigurationChain,
  OrganizerEventPolicy,
  PreparedOrganizerCommand,
} from "./organizer-configuration-chain.js";

export class OrganizerConfigurationConflict extends Error {}
export class OrganizerConfigurationNotFound extends Error {}
export class OrganizerConfigurationRejected extends Error {}

const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const signaturePattern = /^0x[0-9a-fA-F]{130}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";
const zeroHash = `0x${"00".repeat(32)}`;
const uint48Limit = 1n << 48n;

export type OrganizerConfigurationInput =
  | {
      kind: "CONFIG";
      version: bigint;
      validAfter: bigint;
      validUntil: bigint;
      organizerFeeBps: number;
      platformFeeBps: number;
      maximumAcceptanceDuration: bigint;
      maximumSubmissionDelay: bigint;
      organizerDestination: Address;
      platformDestination: Address;
      termsHash: Hex;
      enabled: boolean;
    }
  | { kind: "VENDOR"; vendorId: Hex; authority: Address }
  | {
      kind: "DESTINATION";
      vendorId: Hex;
      version: bigint;
      destination: Address;
      deadline: bigint;
      vendorSignature: Hex;
    }
  | {
      kind: "TERMINAL";
      terminalId: Hex;
      version: bigint;
      vendorId: Hex;
      signer: Address;
      validAfter: bigint;
      validUntil: bigint;
    };

type OperationRow = {
  operation_id: string;
  stream_id: string;
  event_id: Hex;
  registry: Address;
  organizer: Address;
  kind: OrganizerCommandKind;
  aggregate_id: string;
  calldata: Hex;
  command_digest: Hex;
  request_payload: Record<string, unknown>;
  request_hash: Hex;
  state: "PREPARED" | "FINALIZED";
  transaction_hash: Hex | null;
  prepared_block: string;
  prepared_block_hash: Hex;
  finalized_block: string | null;
  finalized_block_hash: Hex | null;
  created_at: Date;
  finalized_at: Date | null;
};

function normalizedAddress(value: Address): Address {
  const address = getAddress(value);
  if (address.toLowerCase() === zeroAddress) throw new OrganizerConfigurationRejected();
  return address;
}

function uint256(value: bigint): void {
  if (value < 1n || value >= 1n << 256n) throw new OrganizerConfigurationRejected();
}

function uint48(value: bigint): void {
  if (value < 0n || value >= uint48Limit) throw new OrganizerConfigurationRejected();
}

function publicOperation(row: OperationRow, organizer: Address, chainId: number) {
  return {
    operationId: row.operation_id,
    kind: row.kind,
    aggregateId: row.aggregate_id,
    state: row.state,
    commandDigest: row.command_digest,
    transactionHash: row.transaction_hash,
    preparedAt: row.created_at.toISOString(),
    preparedBlock: row.prepared_block,
    finalizedBlock: row.finalized_block,
    finalizedBlockHash: row.finalized_block_hash,
    transaction: {
      from: organizer,
      to: getAddress(row.registry),
      data: row.calldata,
      value: "0x0" as const,
      chainId: `0x${chainId.toString(16)}` as Hex,
    },
  };
}

function commandFor(input: OrganizerConfigurationInput): PreparedOrganizerCommand & {
  payload: Record<string, unknown>;
} {
  if (input.kind === "CONFIG") {
    uint256(input.version);
    uint48(input.validAfter);
    uint48(input.validUntil);
    uint48(input.maximumAcceptanceDuration);
    uint48(input.maximumSubmissionDelay);
    if (
      input.validAfter >= input.validUntil ||
      input.maximumAcceptanceDuration < 1n ||
      input.maximumSubmissionDelay < 1n ||
      input.organizerFeeBps < 0 ||
      input.platformFeeBps < 0 ||
      input.organizerFeeBps + input.platformFeeBps > 10_000 ||
      input.termsHash.toLowerCase() === zeroHash
    )
      throw new OrganizerConfigurationRejected();
    const config = {
      validAfter: Number(input.validAfter),
      validUntil: Number(input.validUntil),
      organizerFeeBps: input.organizerFeeBps,
      platformFeeBps: input.platformFeeBps,
      maximumAcceptanceDuration: Number(input.maximumAcceptanceDuration),
      maximumSubmissionDelay: Number(input.maximumSubmissionDelay),
      organizerDestination: normalizedAddress(input.organizerDestination),
      platformDestination: normalizedAddress(input.platformDestination),
      termsHash: input.termsHash.toLowerCase() as Hex,
      enabled: input.enabled,
    };
    return {
      kind: input.kind,
      aggregateId: input.version.toString(),
      calldata: encodeFunctionData({
        abi: eventRegistryAbi,
        functionName: "registerConfig",
        args: [input.version, config],
      }),
      payload: {
        version: input.version.toString(),
        ...config,
        validAfter: input.validAfter.toString(),
        validUntil: input.validUntil.toString(),
        maximumAcceptanceDuration: input.maximumAcceptanceDuration.toString(),
        maximumSubmissionDelay: input.maximumSubmissionDelay.toString(),
      },
    };
  }
  if (input.kind === "VENDOR") {
    if (input.vendorId.toLowerCase() === zeroHash) throw new OrganizerConfigurationRejected();
    const authority = normalizedAddress(input.authority);
    return {
      kind: input.kind,
      aggregateId: input.vendorId.toLowerCase(),
      calldata: encodeFunctionData({
        abi: eventRegistryAbi,
        functionName: "registerVendor",
        args: [input.vendorId, authority],
      }),
      payload: { vendorId: input.vendorId.toLowerCase(), authority },
    };
  }
  if (input.kind === "DESTINATION") {
    uint256(input.version);
    uint256(input.deadline);
    if (input.vendorId.toLowerCase() === zeroHash || !signaturePattern.test(input.vendorSignature))
      throw new OrganizerConfigurationRejected();
    const destination = normalizedAddress(input.destination);
    return {
      kind: input.kind,
      aggregateId: `${input.vendorId.toLowerCase()}:${input.version}`,
      calldata: encodeFunctionData({
        abi: eventRegistryAbi,
        functionName: "registerDestination",
        args: [input.vendorId, input.version, destination, input.deadline, input.vendorSignature],
      }),
      payload: {
        vendorId: input.vendorId.toLowerCase(),
        version: input.version.toString(),
        destination,
        deadline: input.deadline.toString(),
        vendorSignature: input.vendorSignature.toLowerCase(),
      },
    };
  }
  uint256(input.version);
  uint48(input.validAfter);
  uint48(input.validUntil);
  if (
    input.terminalId.toLowerCase() === zeroHash ||
    input.vendorId.toLowerCase() === zeroHash ||
    input.validAfter >= input.validUntil
  )
    throw new OrganizerConfigurationRejected();
  const signer = normalizedAddress(input.signer);
  return {
    kind: input.kind,
    aggregateId: `${input.terminalId.toLowerCase()}:${input.version}`,
    calldata: encodeFunctionData({
      abi: eventRegistryAbi,
      functionName: "registerTerminal",
      args: [
        input.terminalId,
        input.version,
        input.vendorId,
        signer,
        Number(input.validAfter),
        Number(input.validUntil),
      ],
    }),
    payload: {
      terminalId: input.terminalId.toLowerCase(),
      version: input.version.toString(),
      vendorId: input.vendorId.toLowerCase(),
      signer,
      validAfter: input.validAfter.toString(),
      validUntil: input.validUntil.toString(),
    },
  };
}

export class OrganizerConfigurationService {
  readonly #events: OrganizerEventPolicy[];

  constructor(
    private readonly pool: Pool,
    manifest: CheckoutManifest,
    private readonly chain: OrganizerConfigurationChain,
  ) {
    this.#events = manifest.events.map((event) => ({ ...event, chainId: manifest.chainId }));
  }

  async assertReady(): Promise<void> {
    const result = await this.pool.query(
      "SELECT to_regclass('public.organizer_configuration_operations') AS operations",
    );
    if (!result.rows[0]?.operations)
      throw new Error("Organizer configuration migration is not installed");
  }

  policy(identity: OperationsIdentity) {
    if (identity.role !== "ORGANIZER") throw new OrganizerConfigurationRejected();
    const event = this.event(identity, identity.eventId);
    return { chainId: event.chainId, eventId: event.eventId, registry: event.registry };
  }

  async prepare(
    identity: OperationsIdentity,
    eventId: Hex,
    input: OrganizerConfigurationInput,
    idempotencyKey: string,
  ) {
    if (identity.role !== "ORGANIZER" || !idempotencyPattern.test(idempotencyKey))
      throw new OrganizerConfigurationRejected();
    const event = this.event(identity, eventId);
    const command = commandFor(input);
    const requestHash = keccak256(
      encodeAbiParameters(
        [
          { type: "string" },
          { type: "bytes32" },
          { type: "address" },
          { type: "string" },
          { type: "string" },
          { type: "bytes" },
        ],
        [
          identity.streamId,
          event.eventId,
          event.registry,
          command.kind,
          command.aggregateId,
          command.calldata,
        ],
      ),
    );
    const replay = await this.pool.query<OperationRow>(
      `SELECT * FROM organizer_configuration_operations
       WHERE requested_by=$1 AND idempotency_key=$2`,
      [identity.principalId, idempotencyKey],
    );
    const replayRow = replay.rows[0];
    if (replayRow) {
      if (replayRow.request_hash !== requestHash) throw new OrganizerConfigurationConflict();
      return {
        created: false,
        ...publicOperation(replayRow, getAddress(replayRow.organizer), event.chainId),
        statusUrl: `/v1/events/${event.eventId}/configuration-operations/${replayRow.operation_id}`,
      };
    }
    const checkpoint = await this.chain.prepare(event, command);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${identity.principalId}:${idempotencyKey}`,
      ]);
      const existing = await db.query<OperationRow>(
        `SELECT * FROM organizer_configuration_operations
         WHERE requested_by=$1 AND idempotency_key=$2 FOR UPDATE`,
        [identity.principalId, idempotencyKey],
      );
      let row = existing.rows[0];
      let created = false;
      if (row && row.request_hash !== requestHash) throw new OrganizerConfigurationConflict();
      if (!row) {
        const inserted = await db.query<OperationRow>(
          `INSERT INTO organizer_configuration_operations
           (operation_id,stream_id,event_id,registry,organizer,kind,aggregate_id,calldata,
            command_digest,request_payload,requested_by,idempotency_key,request_hash,
            prepared_block,prepared_block_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15) RETURNING *`,
          [
            randomUUID(),
            identity.streamId,
            event.eventId,
            event.registry.toLowerCase(),
            checkpoint.organizer.toLowerCase(),
            command.kind,
            command.aggregateId,
            command.calldata.toLowerCase(),
            keccak256(command.calldata),
            JSON.stringify(command.payload),
            identity.principalId,
            idempotencyKey,
            requestHash,
            checkpoint.blockNumber.toString(),
            checkpoint.blockHash,
          ],
        );
        row = inserted.rows[0];
        created = true;
      }
      if (!row) throw new OrganizerConfigurationRejected();
      await db.query("COMMIT");
      return {
        created,
        ...publicOperation(row, getAddress(row.organizer), event.chainId),
        statusUrl: `/v1/events/${event.eventId}/configuration-operations/${row.operation_id}`,
      };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async confirm(
    identity: OperationsIdentity,
    eventId: Hex,
    operationId: string,
    transactionHash: Hex,
  ) {
    if (identity.role !== "ORGANIZER") throw new OrganizerConfigurationRejected();
    const event = this.event(identity, eventId);
    const result = await this.pool.query<OperationRow>(
      `SELECT * FROM organizer_configuration_operations
       WHERE operation_id=$1 AND stream_id=$2 AND event_id=$3`,
      [operationId, identity.streamId, event.eventId],
    );
    const row = result.rows[0];
    if (!row) throw new OrganizerConfigurationNotFound();
    if (row.state === "FINALIZED") {
      if (row.transaction_hash !== transactionHash.toLowerCase())
        throw new OrganizerConfigurationConflict();
      return publicOperation(row, getAddress(row.organizer), event.chainId);
    }
    const finality = await this.chain.confirm(
      event,
      { kind: row.kind, aggregateId: row.aggregate_id, calldata: row.calldata },
      getAddress(row.organizer),
      transactionHash,
    );
    if (!finality)
      return {
        ...publicOperation(row, getAddress(row.organizer), event.chainId),
        confirmation: "PENDING",
      };
    const updated = await this.pool.query<OperationRow>(
      `UPDATE organizer_configuration_operations
       SET state='FINALIZED',transaction_hash=$2,finalized_block=$3,finalized_block_hash=$4,
           finalized_at=clock_timestamp()
       WHERE operation_id=$1 AND state='PREPARED' RETURNING *`,
      [
        operationId,
        transactionHash.toLowerCase(),
        finality.blockNumber.toString(),
        finality.blockHash,
      ],
    );
    const final = updated.rows[0];
    if (final) return publicOperation(final, getAddress(final.organizer), event.chainId);
    const raced = await this.pool.query<OperationRow>(
      "SELECT * FROM organizer_configuration_operations WHERE operation_id=$1",
      [operationId],
    );
    const racedRow = raced.rows[0];
    if (
      racedRow?.state !== "FINALIZED" ||
      racedRow.transaction_hash !== transactionHash.toLowerCase()
    )
      throw new OrganizerConfigurationConflict();
    return publicOperation(racedRow, getAddress(racedRow.organizer), event.chainId);
  }

  async get(identity: OperationsIdentity, eventId: Hex, operationId: string) {
    if (identity.role !== "ORGANIZER") throw new OrganizerConfigurationRejected();
    const event = this.event(identity, eventId);
    const result = await this.pool.query<OperationRow>(
      `SELECT * FROM organizer_configuration_operations
       WHERE operation_id=$1 AND stream_id=$2 AND event_id=$3`,
      [operationId, identity.streamId, event.eventId],
    );
    const row = result.rows[0];
    if (!row) throw new OrganizerConfigurationNotFound();
    return publicOperation(row, getAddress(row.organizer), event.chainId);
  }

  event(identity: OperationsIdentity, eventId: Hex): OrganizerEventPolicy {
    if (identity.eventId.toLowerCase() !== eventId.toLowerCase())
      throw new OrganizerConfigurationRejected();
    const event = this.#events.find(
      (candidate) =>
        candidate.streamId === identity.streamId && candidate.eventId === eventId.toLowerCase(),
    );
    if (!event) throw new OrganizerConfigurationRejected();
    return event;
  }
}
