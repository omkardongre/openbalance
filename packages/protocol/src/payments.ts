import {
  type Address,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";

export type PaymentIntent = {
  schemaVersion: number;
  chainId: bigint;
  router: Address;
  eventId: Hex;
  paymentId: Hex;
  payerAccount: Address;
  orderRefHash: Hex;
  vendorId: Hex;
  vendorDestinationVersion: bigint;
  terminalInstanceId: Hex;
  asset: Address;
  grossUnits: bigint;
  organizerFeeBps: number;
  platformFeeBps: number;
  configVersion: bigint;
  receiptCommitment: Hex;
  validAfter: number;
  expiresAt: number;
  terminalKeyVersion: bigint;
};

export type RefundIntent = {
  schemaVersion: number;
  chainId: bigint;
  router: Address;
  eventId: Hex;
  refundId: Hex;
  paymentId: Hex;
  payerAccount: Address;
  vendorId: Hex;
  asset: Address;
  refundUnits: bigint;
  cumulativeRefundUnits: bigint;
  vendorCreditUnits: bigint;
  fundingSource: Address;
  validAfter: number;
  expiresAt: number;
};

export type ReserveChannelConfig = {
  channelId: Hex;
  eventId: Hex;
  asset: Address;
  reserveUnits: bigint;
  vendorId: Hex;
  vendorDestinationVersion: bigint;
  terminalInstanceId: Hex;
  terminalKeyVersion: bigint;
  attendeeChannelSigner: Address;
  configVersion: bigint;
  organizerFeeBps: number;
  platformFeeBps: number;
  maxPerVoucher: bigint;
  maxVoucherCount: number;
  acceptFrom: number;
  acceptUntil: number;
  submitUntil: number;
  genesisDigest: Hex;
};

export type OfflineVoucher = {
  protocolVersion: number;
  chainId: bigint;
  vault: Address;
  channelId: Hex;
  sequence: number;
  previousVoucherDigest: Hex;
  paymentId: Hex;
  orderRefHash: Hex;
  grossUnits: bigint;
  cumulativeGrossUnits: bigint;
  receiptCommitment: Hex;
  acceptedAt: number;
  acceptUntil: number;
  submitUntil: number;
  configVersion: bigint;
};

const uint48Limit = 1n << 48n;
const uint32Limit = 1n << 32n;

function validateUnsignedNumber(value: number, limit: bigint, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) >= limit)
    throw new Error(`Invalid ${field}`);
}

export function validateReserveChannelConfig(config: ReserveChannelConfig): void {
  for (const [field, value] of [
    ["acceptFrom", config.acceptFrom],
    ["acceptUntil", config.acceptUntil],
    ["submitUntil", config.submitUntil],
  ] as const)
    validateUnsignedNumber(value, uint48Limit, field);
  validateUnsignedNumber(config.maxVoucherCount, uint32Limit, "maxVoucherCount");
  validateUnsignedNumber(config.organizerFeeBps, 10_001n, "organizerFeeBps");
  validateUnsignedNumber(config.platformFeeBps, 10_001n, "platformFeeBps");
  if (
    config.reserveUnits <= 0n ||
    config.maxPerVoucher <= 0n ||
    config.maxPerVoucher > config.reserveUnits ||
    config.maxVoucherCount === 0 ||
    config.acceptFrom >= config.acceptUntil ||
    config.acceptUntil >= config.submitUntil
  )
    throw new Error("Invalid reserve channel policy");
}

export function validateOfflineVoucher(voucher: OfflineVoucher): void {
  validateUnsignedNumber(voucher.protocolVersion, uint32Limit, "protocolVersion");
  validateUnsignedNumber(voucher.sequence, uint32Limit, "sequence");
  for (const [field, value] of [
    ["acceptedAt", voucher.acceptedAt],
    ["acceptUntil", voucher.acceptUntil],
    ["submitUntil", voucher.submitUntil],
  ] as const)
    validateUnsignedNumber(value, uint48Limit, field);
  if (
    voucher.chainId <= 0n ||
    voucher.grossUnits <= 0n ||
    voucher.cumulativeGrossUnits < voucher.grossUnits ||
    voucher.sequence === 0
  )
    throw new Error("Invalid offline voucher");
}

export const paymentIntentFields = [
  { name: "schemaVersion", type: "uint32" },
  { name: "chainId", type: "uint256" },
  { name: "router", type: "address" },
  { name: "eventId", type: "bytes32" },
  { name: "paymentId", type: "bytes32" },
  { name: "payerAccount", type: "address" },
  { name: "orderRefHash", type: "bytes32" },
  { name: "vendorId", type: "bytes32" },
  { name: "vendorDestinationVersion", type: "uint256" },
  { name: "terminalInstanceId", type: "bytes32" },
  { name: "asset", type: "address" },
  { name: "grossUnits", type: "uint256" },
  { name: "organizerFeeBps", type: "uint16" },
  { name: "platformFeeBps", type: "uint16" },
  { name: "configVersion", type: "uint256" },
  { name: "receiptCommitment", type: "bytes32" },
  { name: "validAfter", type: "uint48" },
  { name: "expiresAt", type: "uint48" },
  { name: "terminalKeyVersion", type: "uint256" },
] as const;

export const refundIntentFields = [
  { name: "schemaVersion", type: "uint32" },
  { name: "chainId", type: "uint256" },
  { name: "router", type: "address" },
  { name: "eventId", type: "bytes32" },
  { name: "refundId", type: "bytes32" },
  { name: "paymentId", type: "bytes32" },
  { name: "payerAccount", type: "address" },
  { name: "vendorId", type: "bytes32" },
  { name: "asset", type: "address" },
  { name: "refundUnits", type: "uint256" },
  { name: "cumulativeRefundUnits", type: "uint256" },
  { name: "vendorCreditUnits", type: "uint256" },
  { name: "fundingSource", type: "address" },
  { name: "validAfter", type: "uint48" },
  { name: "expiresAt", type: "uint48" },
] as const;

export const reserveChannelFields = [
  { name: "channelId", type: "bytes32" },
  { name: "eventId", type: "bytes32" },
  { name: "asset", type: "address" },
  { name: "reserveUnits", type: "uint256" },
  { name: "vendorId", type: "bytes32" },
  { name: "vendorDestinationVersion", type: "uint256" },
  { name: "terminalInstanceId", type: "bytes32" },
  { name: "terminalKeyVersion", type: "uint256" },
  { name: "attendeeChannelSigner", type: "address" },
  { name: "configVersion", type: "uint256" },
  { name: "organizerFeeBps", type: "uint16" },
  { name: "platformFeeBps", type: "uint16" },
  { name: "maxPerVoucher", type: "uint256" },
  { name: "maxVoucherCount", type: "uint32" },
  { name: "acceptFrom", type: "uint48" },
  { name: "acceptUntil", type: "uint48" },
  { name: "submitUntil", type: "uint48" },
  { name: "genesisDigest", type: "bytes32" },
] as const;

export const offlineVoucherFields = [
  { name: "protocolVersion", type: "uint32" },
  { name: "chainId", type: "uint256" },
  { name: "vault", type: "address" },
  { name: "channelId", type: "bytes32" },
  { name: "sequence", type: "uint32" },
  { name: "previousVoucherDigest", type: "bytes32" },
  { name: "paymentId", type: "bytes32" },
  { name: "orderRefHash", type: "bytes32" },
  { name: "grossUnits", type: "uint256" },
  { name: "cumulativeGrossUnits", type: "uint256" },
  { name: "receiptCommitment", type: "bytes32" },
  { name: "acceptedAt", type: "uint48" },
  { name: "acceptUntil", type: "uint48" },
  { name: "submitUntil", type: "uint48" },
  { name: "configVersion", type: "uint256" },
] as const;

const intentType =
  "PaymentIntent(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion)";
const refundType =
  "RefundIntent(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 refundId,bytes32 paymentId,address payerAccount,bytes32 vendorId,address asset,uint256 refundUnits,uint256 cumulativeRefundUnits,uint256 vendorCreditUnits,address fundingSource,uint48 validAfter,uint48 expiresAt)";
const voucherType =
  "OfflineVoucher(uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion)";

export function paymentIntentStructHash(intent: PaymentIntent): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, ...paymentIntentFields],
      [
        keccak256(stringToHex(intentType)),
        intent.schemaVersion,
        intent.chainId,
        intent.router,
        intent.eventId,
        intent.paymentId,
        intent.payerAccount,
        intent.orderRefHash,
        intent.vendorId,
        intent.vendorDestinationVersion,
        intent.terminalInstanceId,
        intent.asset,
        intent.grossUnits,
        intent.organizerFeeBps,
        intent.platformFeeBps,
        intent.configVersion,
        intent.receiptCommitment,
        intent.validAfter,
        intent.expiresAt,
        intent.terminalKeyVersion,
      ],
    ),
  );
}

export function paymentIntentDigest(intent: PaymentIntent): Hex {
  if (intent.chainId <= 0n || intent.chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid payment chain ID");
  }
  return hashTypedData({
    domain: {
      name: "OpenBalanceExactPay",
      version: "1",
      chainId: Number(intent.chainId),
      verifyingContract: intent.router,
    },
    types: { PaymentIntent: paymentIntentFields },
    primaryType: "PaymentIntent",
    message: intent,
  });
}

export function encodePaymentIntent(intent: PaymentIntent): Hex {
  return encodeAbiParameters([{ type: "tuple", components: paymentIntentFields }], [intent]);
}

export function refundIntentStructHash(intent: RefundIntent): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, ...refundIntentFields],
      [
        keccak256(stringToHex(refundType)),
        intent.schemaVersion,
        intent.chainId,
        intent.router,
        intent.eventId,
        intent.refundId,
        intent.paymentId,
        intent.payerAccount,
        intent.vendorId,
        intent.asset,
        intent.refundUnits,
        intent.cumulativeRefundUnits,
        intent.vendorCreditUnits,
        intent.fundingSource,
        intent.validAfter,
        intent.expiresAt,
      ],
    ),
  );
}

export function refundIntentDigest(intent: RefundIntent): Hex {
  if (intent.chainId <= 0n || intent.chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid refund chain ID");
  }
  return hashTypedData({
    domain: {
      name: "OpenBalanceRefund",
      version: "1",
      chainId: Number(intent.chainId),
      verifyingContract: intent.router,
    },
    types: { RefundIntent: refundIntentFields },
    primaryType: "RefundIntent",
    message: intent,
  });
}

export function encodeRefundIntent(intent: RefundIntent): Hex {
  return encodeAbiParameters([{ type: "tuple", components: refundIntentFields }], [intent]);
}

export function reserveChannelTermsHash(input: {
  chainId: bigint;
  vault: Address;
  originalAccount: Address;
  config: ReserveChannelConfig;
}): Hex {
  validateReserveChannelConfig(input.config);
  if (input.chainId <= 0n) throw new Error("Invalid reserve chain ID");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "tuple", components: reserveChannelFields },
      ],
      [input.chainId, input.vault, input.originalAccount, input.config],
    ),
  );
}

export function offlineVoucherStructHash(voucher: OfflineVoucher): Hex {
  validateOfflineVoucher(voucher);
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, ...offlineVoucherFields],
      [
        keccak256(stringToHex(voucherType)),
        voucher.protocolVersion,
        voucher.chainId,
        voucher.vault,
        voucher.channelId,
        voucher.sequence,
        voucher.previousVoucherDigest,
        voucher.paymentId,
        voucher.orderRefHash,
        voucher.grossUnits,
        voucher.cumulativeGrossUnits,
        voucher.receiptCommitment,
        voucher.acceptedAt,
        voucher.acceptUntil,
        voucher.submitUntil,
        voucher.configVersion,
      ],
    ),
  );
}

export function offlineVoucherDigest(voucher: OfflineVoucher): Hex {
  validateOfflineVoucher(voucher);
  if (voucher.chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid voucher chain ID");
  }
  return hashTypedData({
    domain: {
      name: "OpenBalanceOfflineVoucher",
      version: "1",
      chainId: Number(voucher.chainId),
      verifyingContract: voucher.vault,
    },
    types: { OfflineVoucher: offlineVoucherFields },
    primaryType: "OfflineVoucher",
    message: voucher,
  });
}

export function encodeOfflineVoucher(voucher: OfflineVoucher): Hex {
  validateOfflineVoucher(voucher);
  return encodeAbiParameters([{ type: "tuple", components: offlineVoucherFields }], [voucher]);
}

const intentTuple =
  "(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion)";
const refundTuple =
  "(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 refundId,bytes32 paymentId,address payerAccount,bytes32 vendorId,address asset,uint256 refundUnits,uint256 cumulativeRefundUnits,uint256 vendorCreditUnits,address fundingSource,uint48 validAfter,uint48 expiresAt)";
export const reserveChannelTuple =
  "(bytes32 channelId,bytes32 eventId,address asset,uint256 reserveUnits,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,uint256 terminalKeyVersion,address attendeeChannelSigner,uint256 configVersion,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 maxPerVoucher,uint32 maxVoucherCount,uint48 acceptFrom,uint48 acceptUntil,uint48 submitUntil,bytes32 genesisDigest)";
export const offlineVoucherTuple =
  "(uint32 protocolVersion,uint256 chainId,address vault,bytes32 channelId,uint32 sequence,bytes32 previousVoucherDigest,bytes32 paymentId,bytes32 orderRefHash,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 receiptCommitment,uint48 acceptedAt,uint48 acceptUntil,uint48 submitUntil,uint256 configVersion)";

export const exactPayRouterAbi = parseAbi([
  "function eventId() view returns (bytes32)",
  `function quote(bytes encodedIntent) view returns (bytes32 digest,address token,uint256 gross,address payer)`,
  `function intentDigest(${intentTuple} intent) view returns (bytes32)`,
  `function intentStructHash(${intentTuple} intent) pure returns (bytes32)`,
  `function refundDigest(${refundTuple} intent) view returns (bytes32)`,
  `function refundStructHash(${refundTuple} intent) pure returns (bytes32)`,
  "function pay(bytes encodedIntent,bytes terminalSignature)",
  "function cancel(bytes encodedIntent,bytes terminalSignature)",
  `function refund(${refundTuple} intent,bytes vendorSignature)`,
  "function paymentStates(bytes32 paymentId) view returns (uint8)",
  "event PaymentCommitted(bytes32 indexed paymentId,address indexed payer,bytes32 indexed vendorId,uint256 configVersion,uint256 gross,uint256 organizerFee,uint256 platformFee,bytes32 receiptCommitment)",
  "event PaymentCancelled(bytes32 indexed paymentId,address indexed payer)",
  "event RefundCommitted(bytes32 indexed refundId,bytes32 indexed paymentId,address indexed payer,uint256 amount,uint256 vendorCreditUsed)",
]);

export const settlementLedgerAbi = parseAbi([
  "function totalLiability() view returns (uint256)",
  "function credits(bytes32 beneficiaryId) view returns (uint256)",
  "function beneficiaryDestinations(bytes32 beneficiaryId) view returns (address)",
  "function refunds(bytes32 refundId) view returns (bytes32 paymentId)",
  "function refundTerms(bytes32 paymentId) view returns (address payer,bytes32 vendorId,uint256 gross,uint256 refundedGross,bytes32 vendorBeneficiaryId)",
  "function withdrawFor(bytes32 beneficiaryId) returns (uint256 amount)",
  "event PaymentCredited(bytes32 indexed paymentId,address indexed payer,uint256 gross)",
  "event RefundPaid(bytes32 indexed refundId,bytes32 indexed paymentId,address indexed payer,uint256 amount,uint256 vendorCreditUsed)",
  "event Withdrawn(bytes32 indexed beneficiaryId,address indexed destination,uint256 amount)",
]);

export const resilienceVaultAbi = parseAbi([
  "function eventId() view returns (bytes32)",
  `function quoteChannel(${reserveChannelTuple} config) view returns (bytes32 termsHash,address token,uint256 reserveUnits,address originalAccount)`,
  `function openChannel(${reserveChannelTuple} config)`,
  `function settleVoucher(${offlineVoucherTuple} voucher,bytes attendeeSignature,bytes terminalSignature)`,
  "function reclaim(bytes32 channelId) returns (uint256 returnedUnits)",
  `function channelTermsHash(${reserveChannelTuple} config,address originalAccount) view returns (bytes32)`,
  `function channelTermsHashFor(uint256 chainId,address vault,address originalAccount,${reserveChannelTuple} config) pure returns (bytes32)`,
  `function voucherDigest(${offlineVoucherTuple} voucher) view returns (bytes32)`,
  `function voucherStructHash(${offlineVoucherTuple} voucher) pure returns (bytes32)`,
  `function channelConfig(bytes32 channelId) view returns (${reserveChannelTuple})`,
  "function channelState(bytes32 channelId) view returns (address originalAccount,uint256 spentGross,uint32 nextSequence,bytes32 lastVoucherDigest,bool reclaimed)",
  "function channelRecipients(bytes32 channelId) view returns (address vendor,address organizer,address platform)",
  "function totalReserved() view returns (uint256)",
  "function reservedFor(address originalAccount) view returns (uint256)",
  "event ChannelOpened(bytes32 indexed channelId,address indexed originalAccount,bytes32 indexed vendorId,bytes32 terminalInstanceId,uint256 reserveUnits,uint48 acceptUntil,uint48 submitUntil)",
  "event VoucherSettled(bytes32 indexed channelId,bytes32 indexed paymentId,uint32 indexed sequence,uint256 grossUnits,uint256 cumulativeGrossUnits,bytes32 voucherDigest)",
  "event ChannelReclaimed(bytes32 indexed channelId,address indexed originalAccount,uint256 returnedUnits)",
]);

export const eventFactoryAbi = parseAbi([
  "function key(address organizer,bytes32 eventId) pure returns (bytes32)",
  "function getDeployment(address organizer,bytes32 eventId) view returns ((address registry,address ledger,address router,address vault) deployment)",
  "function deployEvent(bytes32 eventId,address asset,address riskOperator,uint16 maximumFeeBps) returns ((address registry,address ledger,address router,address vault) deployment)",
  "event EventDeployed(address indexed organizer,bytes32 indexed eventId,address indexed registry,address ledger,address router,address vault,address asset,address riskOperator,uint16 maximumFeeBps)",
]);
