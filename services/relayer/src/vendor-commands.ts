import {
  exactPayRouterAbi,
  refundIntentDigest,
  settlementLedgerAbi,
  validateRefundIntent,
} from "@openbalance/protocol";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  recoverAddress,
  stringToHex,
} from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";
import type { FinancialOperation, FinancialOperationJournal } from "./financial-operations.js";
import type { VendorTreasuryIdentity } from "./vendor-treasury-access.js";

type JournalPort = Pick<FinancialOperationJournal, "accept" | "getForActor">;

export class VendorCommandRejected extends Error {}
export class VendorCommandNotFound extends Error {}

const signature = /^0x[0-9a-fA-F]{130}$/;
const vendorRole = keccak256(stringToHex("VENDOR"));

function actorFor(identity: VendorTreasuryIdentity): string {
  return `vendor-treasury:${keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [identity.eventId, identity.vendorId, identity.authorityAddress],
    ),
  ).slice(2)}`;
}

function publicOperation(operation: FinancialOperation) {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    aggregateId: operation.aggregateId,
    state: operation.state,
    attempts: operation.attempts,
    transactionHash: operation.transaction?.hash ?? null,
    finalizedBlockNumber: operation.finalizedBlockNumber?.toString() ?? null,
    finalizedBlockHash: operation.finalizedBlockHash,
    failureCode: operation.failureCode,
  };
}

export class VendorFinancialCommandService {
  readonly #journal: JournalPort;
  readonly #manifest: FinancialEventManifest;
  readonly #maximumLifetimeSeconds: bigint;
  readonly #now: () => Date;

  readonly #chainSeconds: (() => Promise<bigint>) | undefined;

  constructor(input: {
    journal: JournalPort;
    manifest: FinancialEventManifest;
    maximumLifetimeSeconds?: bigint;
    now?: () => Date;
    /**
     * Reads the settlement chain's current block timestamp. An intent's `validAfter`/`expiresAt` are
     * evaluated by the contract against `block.timestamp`, so the sponsorship window must be
     * measured in the same time domain rather than against this service's wall clock. Falls back to
     * the local clock only when no chain reader is configured.
     */
    chainSeconds?: () => Promise<bigint>;
  }) {
    if (
      (input.maximumLifetimeSeconds ?? 3_600n) < 30n ||
      (input.maximumLifetimeSeconds ?? 3_600n) > 86_400n
    )
      throw new Error("Invalid vendor command policy");
    this.#journal = input.journal;
    this.#manifest = input.manifest;
    this.#maximumLifetimeSeconds = input.maximumLifetimeSeconds ?? 3_600n;
    this.#now = input.now ?? (() => new Date());
    this.#chainSeconds = input.chainSeconds;
  }

  async acceptRefund(input: {
    identity: VendorTreasuryIdentity;
    paymentId: Hex;
    calldata: Hex;
    idempotencyKey: string;
  }) {
    let decoded: ReturnType<typeof decodeFunctionData<typeof exactPayRouterAbi>>;
    try {
      decoded = decodeFunctionData({ abi: exactPayRouterAbi, data: input.calldata });
    } catch {
      throw new VendorCommandRejected("Refund calldata is invalid");
    }
    if (decoded.functionName !== "refund")
      throw new VendorCommandRejected("Refund selector is not allowed");
    const [intent, vendorSignature] = decoded.args;
    try {
      validateRefundIntent(intent);
    } catch {
      throw new VendorCommandRejected("Refund terms are invalid");
    }
    const event = this.#event(input.identity);
    if (
      !signature.test(vendorSignature) ||
      intent.chainId !== BigInt(this.#manifest.chainId) ||
      getAddress(intent.router) !== event.router ||
      getAddress(intent.asset) !== event.asset ||
      !sameHex(intent.eventId, input.identity.eventId) ||
      !sameHex(intent.vendorId, input.identity.vendorId) ||
      !sameHex(intent.paymentId, input.paymentId) ||
      getAddress(intent.fundingSource) !== getAddress(input.identity.authorityAddress)
    )
      throw new VendorCommandRejected("Refund is outside the vendor treasury scope");
    let recovered: `0x${string}`;
    try {
      recovered = await recoverAddress({
        hash: refundIntentDigest(intent),
        signature: vendorSignature,
      });
    } catch {
      throw new VendorCommandRejected("Refund signature is invalid");
    }
    if (getAddress(recovered) !== getAddress(input.identity.authorityAddress))
      throw new VendorCommandRejected("Refund signature is outside the vendor treasury scope");
    const expiresAt = await this.#expiry(BigInt(intent.expiresAt));
    const accepted = await this.#journal.accept({
      actorId: actorFor(input.identity),
      kind: "REFUND",
      idempotencyKey: input.idempotencyKey,
      commandDigest: keccak256(input.calldata),
      aggregateId: intent.refundId,
      targetAddress: event.router,
      calldata: input.calldata,
      expiresAt,
    });
    return this.#accepted(accepted.created, accepted.operation);
  }

  async acceptWithdrawal(input: {
    identity: VendorTreasuryIdentity;
    destinationVersion: bigint;
    idempotencyKey: string;
  }) {
    if (input.destinationVersion < 1n || input.destinationVersion >= 1n << 256n)
      throw new VendorCommandRejected("Vendor destination version is invalid");
    const event = this.#event(input.identity);
    const beneficiaryId = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [input.identity.eventId, vendorRole, input.identity.vendorId, input.destinationVersion],
      ),
    );
    const calldata = encodeFunctionData({
      abi: settlementLedgerAbi,
      functionName: "withdrawFor",
      args: [beneficiaryId],
    });
    const accepted = await this.#journal.accept({
      actorId: actorFor(input.identity),
      kind: "WITHDRAWAL",
      idempotencyKey: input.idempotencyKey,
      commandDigest: keccak256(calldata),
      aggregateId: beneficiaryId,
      targetAddress: event.ledger,
      calldata,
      expiresAt: new Date(this.#now().getTime() + 10 * 60 * 1_000),
    });
    return this.#accepted(accepted.created, accepted.operation);
  }

  async get(identity: VendorTreasuryIdentity, operationId: string) {
    const operation = await this.#journal.getForActor(operationId, actorFor(identity));
    if (!operation) throw new VendorCommandNotFound();
    return publicOperation(operation);
  }

  #event(identity: VendorTreasuryIdentity) {
    const event = this.#manifest.events.find((candidate) =>
      sameHex(candidate.eventId, identity.eventId),
    );
    if (!event) throw new VendorCommandRejected("Vendor event is not sponsored");
    return event;
  }

  async #expiry(seconds: bigint): Promise<Date> {
    const nowSeconds = this.#chainSeconds
      ? await this.#chainSeconds()
      : BigInt(Math.floor(this.#now().getTime() / 1_000));
    if (seconds <= nowSeconds || seconds - nowSeconds > this.#maximumLifetimeSeconds)
      throw new VendorCommandRejected("Refund expiry is outside the sponsorship window");
    return new Date(Number(seconds) * 1_000);
  }

  #accepted(created: boolean, operation: FinancialOperation) {
    return {
      created,
      ...publicOperation(operation),
      statusUrl: `/v1/vendor-financial-operations/${operation.operationId}`,
    };
  }
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
