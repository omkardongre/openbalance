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

const intentType =
  "PaymentIntent(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion)";

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

const intentTuple =
  "(uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion)";

export const exactPayRouterAbi = parseAbi([
  `function quote(bytes encodedIntent) view returns (bytes32 digest,address token,uint256 gross,address payer)`,
  `function intentDigest(${intentTuple} intent) view returns (bytes32)`,
  `function intentStructHash(${intentTuple} intent) pure returns (bytes32)`,
  "function pay(bytes encodedIntent,bytes terminalSignature)",
  "function cancel(bytes encodedIntent,bytes terminalSignature)",
  "function paymentStates(bytes32 paymentId) view returns (uint8)",
  "event PaymentCommitted(bytes32 indexed paymentId,address indexed payer,bytes32 indexed vendorId,uint256 configVersion,uint256 gross,uint256 organizerFee,uint256 platformFee,bytes32 receiptCommitment)",
  "event PaymentCancelled(bytes32 indexed paymentId,address indexed payer)",
]);

export const settlementLedgerAbi = parseAbi([
  "function totalLiability() view returns (uint256)",
  "function credits(bytes32 beneficiaryId) view returns (uint256)",
  "function beneficiaryDestinations(bytes32 beneficiaryId) view returns (address)",
  "function withdrawFor(bytes32 beneficiaryId) returns (uint256 amount)",
]);
