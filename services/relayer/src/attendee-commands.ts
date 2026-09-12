import type { AccountIdentity } from "@openbalance/api/account-access";
import {
  accountAbi,
  decodePaymentIntent,
  type PaymentIntent,
  validateReserveChannelConfig,
} from "@openbalance/protocol";
import { type Address, decodeFunctionData, getAddress, type Hex, keccak256 } from "viem";
import type {
  AcceptFinancialOperation,
  FinancialOperation,
  FinancialOperationJournal,
} from "./financial-operations.js";

export type AttendeeCommandKind = "PAYMENT" | "CANCELLATION" | "RESERVE_OPEN";

export type FinancialEventCommandPolicy = {
  eventId: Hex;
  router: Address;
  vault: Address;
  asset: Address;
};

export type AttendeeCommandRequest = {
  kind: AttendeeCommandKind;
  idempotencyKey: string;
  calldata: Hex;
};

type JournalPort = Pick<FinancialOperationJournal, "accept" | "getForActor">;

export class AttendeeCommandRejected extends Error {}
export class AttendeeCommandNotFound extends Error {}

const hexBytes = /^0x(?:[0-9a-fA-F]{2})*$/;
const signature = /^0x[0-9a-fA-F]{130}$/;
const zeroHash = `0x${"00".repeat(32)}`;

const actorFor = (account: Address) => `attendee:${account.toLowerCase()}`;

function unixDate(value: bigint): Date {
  if (value < 1n || value > BigInt(Math.floor(8.64e15 / 1_000)))
    throw new AttendeeCommandRejected("Command expiry is invalid");
  return new Date(Number(value) * 1_000);
}

function validateTerminalSignature(value: Hex): void {
  if (!signature.test(value)) throw new AttendeeCommandRejected("Terminal signature is invalid");
}

function validateWebAuthnAuth(value: {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}): void {
  if (
    value.r.toLowerCase() === zeroHash ||
    value.s.toLowerCase() === zeroHash ||
    value.challengeIndex < 0n ||
    value.typeIndex < 0n ||
    !hexBytes.test(value.authenticatorData) ||
    (value.authenticatorData.length - 2) / 2 > 512 ||
    value.clientDataJSON.length < 1 ||
    Buffer.byteLength(value.clientDataJSON, "utf8") > 4_096
  )
    throw new AttendeeCommandRejected("Account authorization is invalid");
}

function paymentIntent(encoded: Hex): PaymentIntent {
  try {
    return decodePaymentIntent(encoded);
  } catch {
    throw new AttendeeCommandRejected("Payment intent is invalid");
  }
}

function assertIntent(
  intent: PaymentIntent,
  account: Address,
  chainId: bigint,
  policies: readonly FinancialEventCommandPolicy[],
): FinancialEventCommandPolicy {
  const policy = policies.find(
    (candidate) =>
      candidate.eventId.toLowerCase() === intent.eventId.toLowerCase() &&
      candidate.router === getAddress(intent.router) &&
      candidate.asset === getAddress(intent.asset),
  );
  if (
    !policy ||
    intent.chainId !== chainId ||
    getAddress(intent.payerAccount) !== getAddress(account)
  )
    throw new AttendeeCommandRejected("Payment intent is outside the attendee scope");
  return policy;
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

/** Validates attendee-owned command semantics before they enter the signer-isolated journal. */
export class AttendeeFinancialCommandService {
  readonly #journal: JournalPort;
  readonly #chainId: bigint;
  readonly #policies: readonly FinancialEventCommandPolicy[];
  readonly #maximumLifetimeSeconds: bigint;
  readonly #now: () => Date;

  constructor(input: {
    journal: JournalPort;
    chainId: bigint;
    events: readonly FinancialEventCommandPolicy[];
    maximumLifetimeSeconds?: bigint;
    now?: () => Date;
  }) {
    if (
      input.chainId < 1n ||
      input.events.length === 0 ||
      (input.maximumLifetimeSeconds ?? 3_600n) < 30n ||
      (input.maximumLifetimeSeconds ?? 3_600n) > 86_400n
    )
      throw new Error("Invalid attendee command policy");
    this.#chainId = input.chainId;
    this.#journal = input.journal;
    this.#maximumLifetimeSeconds = input.maximumLifetimeSeconds ?? 3_600n;
    this.#now = input.now ?? (() => new Date());
    this.#policies = input.events.map((event) => ({
      eventId: event.eventId.toLowerCase() as Hex,
      router: getAddress(event.router),
      vault: getAddress(event.vault),
      asset: getAddress(event.asset),
    }));
    if (
      new Set(this.#policies.map((event) => event.eventId)).size !== this.#policies.length ||
      this.#policies.some((event) => event.eventId === zeroHash)
    )
      throw new Error("Duplicate or invalid attendee event policy");
  }

  async accept(identity: AccountIdentity, request: AttendeeCommandRequest) {
    const parsed = this.#parse(identity.account, request);
    const nowSeconds = BigInt(Math.floor(this.#now().getTime() / 1_000));
    const expirySeconds = BigInt(Math.floor(parsed.expiresAt.getTime() / 1_000));
    if (expirySeconds <= nowSeconds || expirySeconds - nowSeconds > this.#maximumLifetimeSeconds)
      throw new AttendeeCommandRejected("Command expiry is outside the sponsorship window");
    const accepted = await this.#journal.accept(parsed);
    return {
      created: accepted.created,
      ...publicOperation(accepted.operation),
      statusUrl: `/v1/financial-operations/${accepted.operation.operationId}`,
    };
  }

  async get(identity: AccountIdentity, operationId: string) {
    const operation = await this.#journal.getForActor(operationId, actorFor(identity.account));
    if (!operation) throw new AttendeeCommandNotFound();
    return publicOperation(operation);
  }

  #parse(account: Address, request: AttendeeCommandRequest): AcceptFinancialOperation {
    let decoded: ReturnType<typeof decodeFunctionData<typeof accountAbi>>;
    try {
      decoded = decodeFunctionData({ abi: accountAbi, data: request.calldata });
    } catch {
      throw new AttendeeCommandRejected("Account command calldata is invalid");
    }
    const common = {
      actorId: actorFor(account),
      idempotencyKey: request.idempotencyKey,
      commandDigest: keccak256(request.calldata),
      targetAddress: getAddress(account),
      calldata: request.calldata,
    };

    if (request.kind === "PAYMENT") {
      if (decoded.functionName === "pay") {
        const [router, encodedIntent, terminalSignature, deadline, , auth] = decoded.args;
        const intent = paymentIntent(encodedIntent);
        const policy = assertIntent(intent, account, this.#chainId, this.#policies);
        if (getAddress(router) !== policy.router)
          throw new AttendeeCommandRejected("Payment router is outside the event policy");
        validateTerminalSignature(terminalSignature);
        validateWebAuthnAuth(auth);
        const expiresAt = unixDate(
          deadline < BigInt(intent.expiresAt) ? deadline : BigInt(intent.expiresAt),
        );
        return { ...common, kind: request.kind, aggregateId: intent.paymentId, expiresAt };
      }
      if (decoded.functionName === "payWithOnlineSession") {
        const [, encodedIntent, terminalSignature, r, s] = decoded.args;
        const intent = paymentIntent(encodedIntent);
        assertIntent(intent, account, this.#chainId, this.#policies);
        validateTerminalSignature(terminalSignature);
        if (r.toLowerCase() === zeroHash || s.toLowerCase() === zeroHash)
          throw new AttendeeCommandRejected("Online session signature is invalid");
        return {
          ...common,
          kind: request.kind,
          aggregateId: intent.paymentId,
          expiresAt: unixDate(BigInt(intent.expiresAt)),
        };
      }
      throw new AttendeeCommandRejected("Payment command selector is not allowed");
    }

    if (request.kind === "CANCELLATION") {
      if (decoded.functionName !== "cancelPayment")
        throw new AttendeeCommandRejected("Cancellation command selector is not allowed");
      const [router, encodedIntent, terminalSignature, deadline, , auth] = decoded.args;
      const intent = paymentIntent(encodedIntent);
      const policy = assertIntent(intent, account, this.#chainId, this.#policies);
      if (getAddress(router) !== policy.router)
        throw new AttendeeCommandRejected("Cancellation router is outside the event policy");
      validateTerminalSignature(terminalSignature);
      validateWebAuthnAuth(auth);
      const expiresAt = unixDate(
        deadline < BigInt(intent.expiresAt) ? deadline : BigInt(intent.expiresAt),
      );
      return { ...common, kind: request.kind, aggregateId: intent.paymentId, expiresAt };
    }

    if (decoded.functionName !== "openReserveChannel")
      throw new AttendeeCommandRejected("Reserve command selector is not allowed");
    const [vault, config, maximumTotalReserve, deadline, , auth] = decoded.args;
    try {
      validateReserveChannelConfig(config);
    } catch {
      throw new AttendeeCommandRejected("Reserve terms are invalid");
    }
    const policy = this.#policies.find(
      (candidate) =>
        candidate.eventId === config.eventId.toLowerCase() &&
        candidate.vault === getAddress(vault) &&
        candidate.asset === getAddress(config.asset),
    );
    if (!policy || maximumTotalReserve < config.reserveUnits)
      throw new AttendeeCommandRejected("Reserve command is outside the attendee policy");
    validateWebAuthnAuth(auth);
    const expiresAt = unixDate(
      deadline < BigInt(config.acceptUntil) ? deadline : BigInt(config.acceptUntil),
    );
    return { ...common, kind: request.kind, aggregateId: config.channelId, expiresAt };
  }
}
