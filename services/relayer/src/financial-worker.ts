import { type Address, getAddress, type Hex } from "viem";
import {
  type FinancialOperation,
  type FinancialOperationJournal,
  type FinancialOperationKind,
  FinancialReserveBudgetExhausted,
  type SignedTransaction,
} from "./financial-operations.js";

const address = /^0x[0-9a-fA-F]{40}$/;
const selector = /^0x[0-9a-fA-F]{8}$/;
const workerId = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const code = /^[a-z][a-z0-9_]{2,63}$/;

export type FinancialCommandProposal = {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type FinancialFinalityObservation =
  | { status: "FINALIZED"; blockNumber: bigint; blockHash: Hex }
  | { status: "PENDING" }
  | { status: "ABSENT" }
  | { status: "REVERTED"; code: string };

export interface FinancialTransactionGateway {
  readonly chainId: number;
  /** Every key available for sponsorship. Throughput per key is capped by its inflight gas budget. */
  readonly signerAddresses: readonly Address[];
  pendingNonce(signerAddress: Address): Promise<bigint>;
  /**
   * Total gas spend the chain will let this key hold inflight at once, in wei, or `null` when the
   * chain enforces no such ceiling. `null` and `0n` are deliberately distinct: zero is a funded-but-
   * exhausted key that must not be used, whereas an unfunded key reporting zero must not be mistaken
   * for an unrestricted one.
   */
  inflightGasBudget(signerAddress: Address): Promise<bigint | null>;
  simulate(operation: FinancialOperation): Promise<FinancialCommandProposal>;
  sign(input: {
    operation: FinancialOperation;
    nonce: bigint;
    proposal: FinancialCommandProposal;
    signerAddress: Address;
  }): Promise<SignedTransaction>;
  broadcast(rawTransaction: Hex): Promise<Hex>;
}

/** This boundary must verify the expected domain event, not only a successful transaction receipt. */
export interface FinancialFinalityVerifier {
  inspect(operation: FinancialOperation): Promise<FinancialFinalityObservation>;
}

export interface FinancialCommandPolicy {
  readonly chainId: number;
  assertCommand(operation: FinancialOperation): void | Promise<void>;
  assertProposal(
    operation: FinancialOperation,
    proposal: FinancialCommandProposal,
  ): void | Promise<void>;
}

export type FinancialCallRule = {
  kind: FinancialOperationKind;
  targetAddress: Address;
  selector: Hex;
};

export class PermanentFinancialOperationFailure extends Error {
  constructor(
    readonly failureCode: string,
    message = failureCode,
  ) {
    super(message);
    if (!code.test(failureCode)) throw new Error("Invalid permanent failure code");
  }
}

export class TransientFinancialOperationFailure extends Error {
  constructor(
    readonly failureCode: string,
    message = failureCode,
  ) {
    super(message);
    if (!code.test(failureCode)) throw new Error("Invalid transient failure code");
  }
}

export class FinancialOperationIntegrityFailure extends Error {
  constructor(
    readonly failureCode: string,
    message = failureCode,
  ) {
    super(message);
    if (!code.test(failureCode)) throw new Error("Invalid integrity failure code");
  }
}

/** A fixed target/selector and fee budget policy for one configured event environment. */
export class BoundedFinancialCommandPolicy implements FinancialCommandPolicy {
  readonly chainId: number;
  readonly #rules: FinancialCallRule[];
  readonly #maxGasLimit: bigint;
  readonly #maxFeePerGas: bigint;
  readonly #maxCost: bigint;

  constructor(input: {
    chainId: number;
    rules: readonly FinancialCallRule[];
    maxGasLimit: bigint;
    maxFeePerGas: bigint;
    maxCost: bigint;
  }) {
    if (
      !Number.isSafeInteger(input.chainId) ||
      input.chainId < 1 ||
      input.rules.length === 0 ||
      input.maxGasLimit < 21_000n ||
      input.maxFeePerGas < 1n ||
      input.maxCost < 1n
    )
      throw new Error("Invalid financial command policy");
    const normalized = input.rules.map((rule) => {
      if (!address.test(rule.targetAddress) || !selector.test(rule.selector))
        throw new Error("Invalid financial call rule");
      return {
        ...rule,
        targetAddress: getAddress(rule.targetAddress),
        selector: rule.selector.toLowerCase() as Hex,
      };
    });
    if (
      new Set(normalized.map((rule) => `${rule.kind}:${rule.targetAddress}:${rule.selector}`))
        .size !== normalized.length
    )
      throw new Error("Duplicate financial call rule");
    this.chainId = input.chainId;
    this.#rules = normalized;
    this.#maxGasLimit = input.maxGasLimit;
    this.#maxFeePerGas = input.maxFeePerGas;
    this.#maxCost = input.maxCost;
  }

  assertCommand(operation: FinancialOperation): void {
    const rule = this.#rules.find(
      (candidate) =>
        candidate.kind === operation.kind &&
        candidate.targetAddress === getAddress(operation.targetAddress) &&
        candidate.selector === operation.calldata.slice(0, 10).toLowerCase(),
    );
    if (!rule)
      throw new PermanentFinancialOperationFailure(
        "command_not_sponsored",
        "Command target or selector is not sponsored",
      );
  }

  assertProposal(_operation: FinancialOperation, proposal: FinancialCommandProposal): void {
    if (
      proposal.gasLimit < 21_000n ||
      proposal.gasLimit > this.#maxGasLimit ||
      proposal.maxFeePerGas < 1n ||
      proposal.maxFeePerGas > this.#maxFeePerGas ||
      proposal.maxPriorityFeePerGas < 0n ||
      proposal.maxPriorityFeePerGas > proposal.maxFeePerGas ||
      proposal.gasLimit * proposal.maxFeePerGas > this.#maxCost
    )
      throw new PermanentFinancialOperationFailure(
        "sponsorship_budget_exceeded",
        "Command exceeds relayer sponsorship policy",
      );
  }
}

export type FinancialOperationJournalPort = Pick<
  FinancialOperationJournal,
  | "claim"
  | "deferReconciliation"
  | "expireUnclaimed"
  | "failBeforeSigning"
  | "listForReconciliation"
  | "markFinalized"
  | "markReverted"
  | "markSigned"
  | "markSubmitted"
  | "quarantine"
  | "recoverExpiredLeases"
  | "reserveNonceFromPool"
  | "retry"
>;

export type FinancialWorkerRun = {
  expiredLeases: number;
  expiredUnclaimed: number;
  accepted: number;
  signed: number;
  submitted: number;
  finalized: number;
  reverted: number;
  retried: number;
  quarantined: number;
  pending: number;
};

type WorkerOutcome = keyof Omit<FinancialWorkerRun, "expiredLeases" | "expiredUnclaimed">;

export class FinancialOperationWorker {
  readonly #journal: FinancialOperationJournalPort;
  readonly #gateway: FinancialTransactionGateway;
  readonly #policy: FinancialCommandPolicy;
  readonly #finality: FinancialFinalityVerifier;
  readonly #owner: string;
  readonly #batchSize: number;
  readonly #leaseMilliseconds: number;
  readonly #retryDelayMilliseconds: number;

  constructor(input: {
    journal: FinancialOperationJournalPort;
    gateway: FinancialTransactionGateway;
    policy: FinancialCommandPolicy;
    finality: FinancialFinalityVerifier;
    owner: string;
    batchSize?: number;
    leaseMilliseconds?: number;
    retryDelayMilliseconds?: number;
  }) {
    if (
      !workerId.test(input.owner) ||
      input.gateway.chainId !== input.policy.chainId ||
      input.gateway.signerAddresses.length === 0 ||
      !input.gateway.signerAddresses.every((signer) => address.test(signer)) ||
      new Set(input.gateway.signerAddresses.map((signer) => signer.toLowerCase())).size !==
        input.gateway.signerAddresses.length ||
      !Number.isSafeInteger(input.batchSize ?? 25) ||
      (input.batchSize ?? 25) < 1 ||
      (input.batchSize ?? 25) > 100 ||
      !Number.isSafeInteger(input.leaseMilliseconds ?? 30_000) ||
      (input.leaseMilliseconds ?? 30_000) < 1_000 ||
      (input.leaseMilliseconds ?? 30_000) > 300_000 ||
      !Number.isSafeInteger(input.retryDelayMilliseconds ?? 15_000) ||
      (input.retryDelayMilliseconds ?? 15_000) < 1_000 ||
      (input.retryDelayMilliseconds ?? 15_000) > 86_400_000
    )
      throw new Error("Invalid financial operation worker configuration");
    this.#journal = input.journal;
    this.#gateway = input.gateway;
    this.#policy = input.policy;
    this.#finality = input.finality;
    this.#owner = input.owner;
    this.#batchSize = input.batchSize ?? 25;
    this.#leaseMilliseconds = input.leaseMilliseconds ?? 30_000;
    this.#retryDelayMilliseconds = input.retryDelayMilliseconds ?? 15_000;
  }

  async runOnce(): Promise<FinancialWorkerRun> {
    const run: FinancialWorkerRun = {
      expiredLeases: await this.#journal.recoverExpiredLeases(),
      expiredUnclaimed: await this.#journal.expireUnclaimed(),
      accepted: 0,
      signed: 0,
      submitted: 0,
      finalized: 0,
      reverted: 0,
      retried: 0,
      quarantined: 0,
      pending: 0,
    };
    for (const operation of await this.#journal.listForReconciliation(this.#batchSize)) {
      this.#record(run, await this.#reconcile(operation));
    }
    for (const operation of await this.#journal.claim(
      this.#batchSize,
      this.#owner,
      this.#leaseMilliseconds,
    )) {
      run.accepted += 1;
      for (const outcome of await this.#process(operation)) this.#record(run, outcome);
    }
    return run;
  }

  async #process(operation: FinancialOperation): Promise<WorkerOutcome[]> {
    if (!operation.leaseToken) throw new FinancialOperationIntegrityFailure("missing_lease_token");
    try {
      await this.#policy.assertCommand(operation);
      const proposal = await this.#gateway.simulate(operation);
      await this.#policy.assertProposal(operation, proposal);
      // The declared limit is what the chain charges and what it counts against the inflight budget,
      // so the commitment is the limit, never the eventual usage.
      const commitmentWei = proposal.gasLimit * proposal.maxFeePerGas;
      const candidates = await Promise.all(
        this.#gateway.signerAddresses.map(async (signerAddress) => ({
          signerAddress,
          pendingNonce: await this.#gateway.pendingNonce(signerAddress),
          budgetWei: await this.#gateway.inflightGasBudget(signerAddress),
        })),
      );
      const { signerAddress, nonce } = await this.#journal.reserveNonceFromPool(
        operation.operationId,
        operation.leaseToken,
        candidates,
        commitmentWei,
      );
      const transaction = await this.#gateway.sign({
        operation,
        nonce,
        proposal,
        signerAddress,
      });
      if (getAddress(transaction.signerAddress) !== getAddress(signerAddress))
        throw new FinancialOperationIntegrityFailure(
          "unexpected_signer",
          "Gateway returned a transaction for another signer",
        );
      const signed = await this.#journal.markSigned(
        operation.operationId,
        operation.leaseToken,
        transaction,
      );
      return ["signed", await this.#broadcast(signed)];
    } catch (error) {
      if (error instanceof FinancialOperationIntegrityFailure) {
        await this.#journal.quarantine(operation.operationId, "LEASED", error.failureCode);
        return ["quarantined"];
      }
      if (error instanceof PermanentFinancialOperationFailure) {
        await this.#journal.failBeforeSigning(
          operation.operationId,
          operation.leaseToken,
          error.failureCode,
        );
        return ["reverted"];
      }
      await this.#journal.retry(
        operation.operationId,
        operation.leaseToken,
        this.#backoff(operation.attempts),
        error instanceof FinancialReserveBudgetExhausted
          ? "reserve_budget_exhausted"
          : error instanceof TransientFinancialOperationFailure
            ? error.failureCode
            : "pre_sign_unavailable",
      );
      return ["retried"];
    }
  }

  async #broadcast(operation: FinancialOperation): Promise<WorkerOutcome> {
    if (!operation.transaction)
      throw new FinancialOperationIntegrityFailure("missing_signed_transaction");
    try {
      const hash = await this.#gateway.broadcast(operation.transaction.rawTransaction);
      if (hash.toLowerCase() !== operation.transaction.hash.toLowerCase()) {
        await this.#journal.quarantine(
          operation.operationId,
          operation.state,
          "broadcast_hash_mismatch",
        );
        return "quarantined";
      }
      await this.#journal.markSubmitted(operation.operationId, operation.transaction.hash);
      return "submitted";
    } catch (error) {
      if (error instanceof FinancialOperationIntegrityFailure) throw error;
      return this.#defer(operation, "broadcast_unknown");
    }
  }

  async #reconcile(operation: FinancialOperation): Promise<WorkerOutcome> {
    if (!operation.transaction)
      throw new FinancialOperationIntegrityFailure("missing_signed_transaction");
    try {
      const observation = await this.#finality.inspect(operation);
      switch (observation.status) {
        case "FINALIZED":
          await this.#journal.markFinalized(
            operation.operationId,
            operation.transaction.hash,
            observation.blockNumber,
            observation.blockHash,
          );
          return "finalized";
        case "REVERTED":
          await this.#journal.markReverted(
            operation.operationId,
            operation.transaction.hash,
            observation.code,
          );
          return "reverted";
        case "PENDING":
          await this.#journal.markSubmitted(operation.operationId, operation.transaction.hash);
          return "pending";
        case "ABSENT":
          return this.#broadcast(operation);
      }
    } catch (error) {
      if (error instanceof FinancialOperationIntegrityFailure) {
        await this.#journal.quarantine(operation.operationId, operation.state, error.failureCode);
        return "quarantined";
      }
      return this.#defer(
        operation,
        error instanceof TransientFinancialOperationFailure
          ? error.failureCode
          : "reconciliation_unavailable",
      );
    }
  }

  async #defer(operation: FinancialOperation, failureCode: string): Promise<WorkerOutcome> {
    if (!operation.transaction)
      throw new FinancialOperationIntegrityFailure("missing_signed_transaction");
    await this.#journal.deferReconciliation(
      operation.operationId,
      operation.transaction.hash,
      this.#backoff(operation.attempts),
      failureCode,
    );
    return "pending";
  }

  #backoff(attempts: number): number {
    const multiplier = 2 ** Math.min(Math.max(attempts - 1, 0), 8);
    return Math.min(this.#retryDelayMilliseconds * multiplier, 86_400_000);
  }

  #record(run: FinancialWorkerRun, outcome: WorkerOutcome): void {
    run[outcome] += 1;
  }
}
