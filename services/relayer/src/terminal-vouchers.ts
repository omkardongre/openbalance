import {
  decodeOfflineVoucher,
  type OfflineVoucher,
  offlineVoucherDigest,
  resilienceVaultAbi,
  terminalIngressDigest,
  type VoucherReceipt,
  validateVoucherReceipt,
  voucherReceiptPayloadHash,
} from "@openbalance/protocol";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
  recoverAddress,
} from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";
import type { FinancialOperation, FinancialOperationJournal } from "./financial-operations.js";
import { VendorCommandRejected } from "./vendor-commands.js";
import { type FinalizedChannel, VoucherChannelNotFound } from "./vendor-vouchers.js";

type JournalPort = Pick<FinancialOperationJournal, "accept" | "findByIdempotency">;

/** The terminal a channel was opened for, as the vault and event registry recorded it. */
export type ChannelTerminal = {
  terminalInstanceId: Hex;
  terminalKeyVersion: bigint;
  signer: Address;
};

export type TerminalAuthorization = {
  keyVersion: bigint;
  sentAt: number;
  nonce: Hex;
  signature: Hex;
};

/** The relay acknowledgement the terminal already understands from a venue relay. */
export type TerminalIngressAcknowledgement = {
  receiptId: string;
  state: "PENDING" | "SUBMITTED" | "SETTLED" | "QUARANTINED";
  transactionHash: Hex | null;
  duplicate: boolean;
};

export class TerminalIngressRejected extends Error {}

const KIND = "VOUCHER_SETTLE" as const;

/**
 * Cloud ingress for terminal receipts: the same `POST /v1/vouchers` contract a venue relay serves, so
 * a terminal that regains internet uploads its offline sales directly and the venue relay becomes an
 * optional on-site fallback rather than a required component.
 *
 * Authentication is the terminal's own key, not a credential stored on the device. The request is
 * signed with the terminal key over this ingress audience, and that key must be the one the event
 * registry bound to the channel when it opened. `settleVoucher` is permissionless and re-checks both
 * signatures on-chain, so this only decides which vouchers the sponsor pays gas for: valid ones from
 * the channel's own terminal, while the channel can still settle.
 */
export class TerminalVoucherIngressService {
  readonly #journal: JournalPort;
  readonly #manifest: FinancialEventManifest;
  readonly #channel: (eventId: Hex, channelId: Hex) => Promise<FinalizedChannel | undefined>;
  readonly #terminal: (vault: Address, channelId: Hex) => Promise<ChannelTerminal | undefined>;
  readonly #chainSeconds: () => Promise<bigint>;
  readonly #audience: string;
  readonly #maximumClockSkewSeconds: number;
  readonly #now: () => number;

  constructor(input: {
    journal: JournalPort;
    manifest: FinancialEventManifest;
    channel: (eventId: Hex, channelId: Hex) => Promise<FinalizedChannel | undefined>;
    terminal: (vault: Address, channelId: Hex) => Promise<ChannelTerminal | undefined>;
    chainSeconds: () => Promise<bigint>;
    audience: string;
    maximumClockSkewSeconds?: number;
    now?: () => number;
  }) {
    const skew = input.maximumClockSkewSeconds ?? 120;
    if (!/^https:\/\/[^/?#\s]+\/v1\/vouchers$/.test(input.audience) || skew < 1 || skew > 900)
      throw new Error("Invalid terminal ingress policy");
    this.#journal = input.journal;
    this.#manifest = input.manifest;
    this.#channel = input.channel;
    this.#terminal = input.terminal;
    this.#chainSeconds = input.chainSeconds;
    this.#audience = input.audience;
    this.#maximumClockSkewSeconds = skew;
    this.#now = input.now ?? Date.now;
  }

  async accept(input: {
    receipt: VoucherReceipt;
    authorization: TerminalAuthorization;
  }): Promise<TerminalIngressAcknowledgement> {
    const { receipt, authorization } = input;
    let voucher: OfflineVoucher;
    try {
      validateVoucherReceipt(receipt);
      voucher = decodeOfflineVoucher(receipt.voucher);
    } catch {
      throw new TerminalIngressRejected("Voucher receipt is invalid");
    }
    if (
      voucher.channelId.toLowerCase() !== receipt.channelId.toLowerCase() ||
      voucher.paymentId.toLowerCase() !== receipt.paymentId.toLowerCase() ||
      voucher.sequence !== receipt.sequence
    )
      throw new TerminalIngressRejected("Receipt metadata does not match voucher");
    const nowSeconds = Math.floor(this.#now() / 1_000);
    if (
      Math.abs(nowSeconds - authorization.sentAt) > this.#maximumClockSkewSeconds ||
      authorization.keyVersion <= 0n
    )
      throw new TerminalIngressRejected("Terminal authorization is expired or invalid");

    const event = this.#manifest.events.find((candidate) => {
      try {
        return getAddress(voucher.vault) === candidate.vault;
      } catch {
        return false;
      }
    });
    if (!event || voucher.chainId !== BigInt(this.#manifest.chainId))
      throw new TerminalIngressRejected("Voucher is outside the sponsored events");

    const terminal = await this.#terminal(event.vault, voucher.channelId);
    if (!terminal) throw new VoucherChannelNotFound();
    if (
      terminal.terminalInstanceId.toLowerCase() !== receipt.terminalId.toLowerCase() ||
      terminal.terminalKeyVersion !== authorization.keyVersion
    )
      throw new TerminalIngressRejected("Terminal does not own this channel");
    const digest = terminalIngressDigest({
      audience: this.#audience,
      terminalId: receipt.terminalId,
      keyVersion: authorization.keyVersion,
      sentAt: authorization.sentAt,
      nonce: authorization.nonce,
      payloadHash: `0x${voucherReceiptPayloadHash(receipt)}`,
    });
    let transportSigner: Address;
    let voucherSigner: Address;
    try {
      [transportSigner, voucherSigner] = await Promise.all([
        recoverAddress({ hash: digest, signature: authorization.signature }),
        recoverAddress({
          hash: offlineVoucherDigest(voucher),
          signature: receipt.terminalSignature,
        }),
      ]);
    } catch {
      throw new TerminalIngressRejected("Terminal signature is invalid");
    }
    if (
      getAddress(transportSigner) !== getAddress(terminal.signer) ||
      getAddress(voucherSigner) !== getAddress(terminal.signer)
    )
      throw new TerminalIngressRejected("Terminal signature does not match the channel");

    // Every terminal retry and status poll resends the same receipt; answer from the journal first so
    // a voucher that already settled still reports SETTLED with its transaction.
    const actorId = `terminal:${receipt.terminalId.toLowerCase()}`;
    const idempotencyKey = `voucher:${voucher.paymentId.toLowerCase()}`;
    const prior = await this.#journal.findByIdempotency(actorId, KIND, idempotencyKey);
    if (prior) return acknowledgement(receipt, prior, true);

    const channel = await this.#channel(event.eventId, voucher.channelId);
    if (!channel) throw new VoucherChannelNotFound();
    if (channel.reclaimed || voucher.sequence < channel.nextSequence)
      throw new VendorCommandRejected("Voucher is already settled or the channel is closed");
    if (BigInt(voucher.submitUntil) !== channel.submitUntil)
      throw new VendorCommandRejected("Voucher terms do not match the channel");
    if (channel.submitUntil <= (await this.#chainSeconds()))
      throw new VendorCommandRejected("Voucher submission window has closed");

    const calldata = encodeFunctionData({
      abi: resilienceVaultAbi,
      functionName: "settleVoucher",
      args: [voucher, receipt.attendeeSignature, receipt.terminalSignature],
    });
    const accepted = await this.#journal.accept({
      actorId,
      kind: KIND,
      idempotencyKey,
      commandDigest: keccak256(calldata),
      aggregateId: voucher.paymentId,
      targetAddress: event.vault,
      calldata,
      // Deterministic, so a retried upload is the same command rather than an idempotency conflict.
      expiresAt: new Date(Number(channel.submitUntil) * 1_000),
    });
    return acknowledgement(receipt, accepted.operation, !accepted.created);
  }
}

function acknowledgement(
  receipt: VoucherReceipt,
  operation: FinancialOperation,
  duplicate: boolean,
): TerminalIngressAcknowledgement {
  const transactionHash = operation.transaction?.hash ?? null;
  const state =
    operation.state === "FINALIZED"
      ? "SETTLED"
      : operation.state === "FAILED" || operation.state === "QUARANTINED"
        ? "QUARANTINED"
        : operation.state === "SUBMITTED"
          ? "SUBMITTED"
          : "PENDING";
  return { receiptId: receipt.receiptId, state, transactionHash, duplicate };
}

const vaultAbi = parseAbi(["function registry() view returns (address)"]);
const registryAbi = parseAbi([
  "function historicalTerminalSigner(bytes32 terminalId,uint256 version,bytes32 vendorId) view returns (address)",
]);

/**
 * Reads the terminal a channel is bound to at the finality tag. The vault fixes the channel's terminal
 * instance and key version when it opens, and registry terminal records are write-once, so the
 * registry's signer for that version is the key that must have signed.
 */
export function chainChannelTerminalReader(
  rpcUrl: string,
  blockTag: "finalized" | "safe" | "latest",
) {
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
  });
  const registries = new Map<Address, Address>();
  return async (vault: Address, channelId: Hex): Promise<ChannelTerminal | undefined> => {
    const config = await client.readContract({
      address: vault,
      abi: resilienceVaultAbi,
      functionName: "channelConfig",
      args: [channelId],
      blockTag,
    });
    if (BigInt(config.channelId) === 0n) return undefined;
    let registry = registries.get(vault);
    if (!registry) {
      registry = await client.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "registry",
      });
      registries.set(vault, registry);
    }
    const signer = await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "historicalTerminalSigner",
      args: [config.terminalInstanceId, config.terminalKeyVersion, config.vendorId],
      blockTag,
    });
    if (BigInt(signer) === 0n) return undefined;
    return {
      terminalInstanceId: config.terminalInstanceId,
      terminalKeyVersion: config.terminalKeyVersion,
      signer: getAddress(signer),
    };
  };
}
