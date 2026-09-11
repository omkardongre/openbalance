import {
  type Address,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { reserveChannelTuple } from "./payments.js";

export type Ownership = {
  primary: { x: Hex; y: Hex };
  backup: { x: Hex; y: Hex };
  recovery: Address;
};
export type OnlineSessionConfig = {
  sessionId: Hex;
  signer: { x: Hex; y: Hex };
  eventId: Hex;
  router: Address;
  asset: Address;
  maxPerPayment: bigint;
  maxTotal: bigint;
  validAfter: number;
  validUntil: number;
};
const keyComponents = [
  { name: "x", type: "bytes32" },
  { name: "y", type: "bytes32" },
] as const;
export const onlineSessionConfigComponents = [
  { name: "sessionId", type: "bytes32" },
  { name: "signer", type: "tuple", components: keyComponents },
  { name: "eventId", type: "bytes32" },
  { name: "router", type: "address" },
  { name: "asset", type: "address" },
  { name: "maxPerPayment", type: "uint256" },
  { name: "maxTotal", type: "uint256" },
  { name: "validAfter", type: "uint48" },
  { name: "validUntil", type: "uint48" },
] as const;
export const ownershipComponents = [
  {
    name: "primary",
    type: "tuple",
    components: [
      { name: "x", type: "bytes32" },
      { name: "y", type: "bytes32" },
    ],
  },
  {
    name: "backup",
    type: "tuple",
    components: [
      { name: "x", type: "bytes32" },
      { name: "y", type: "bytes32" },
    ],
  },
  { name: "recovery", type: "address" },
] as const;
export function ownershipHash(ownership: Ownership): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "tuple", components: ownershipComponents }], [ownership]),
  );
}
export function withdrawalHash(asset: Address, recipient: Address, amount: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [asset, recipient, amount],
    ),
  );
}
export function validatorPermissionHash(validator: Address, enabled: boolean): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bool" }], [validator, enabled]),
  );
}
export function validatorCallHash(validator: Address, purpose: Hex, payloadHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [validator, purpose, payloadHash],
    ),
  );
}
export function onlineSessionTermsHash(config: OnlineSessionConfig): Hex {
  validateOnlineSessionConfig(config);
  return keccak256(
    encodeAbiParameters([{ type: "tuple", components: onlineSessionConfigComponents }], [config]),
  );
}
export function sessionPaymentDigest(input: {
  chainId: number;
  account: Address;
  sessionId: Hex;
  revision: bigint;
  intentDigest: Hex;
  accountEpoch: bigint;
}): Hex {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0)
    throw new Error("Invalid chain ID");
  for (const value of [input.revision, input.accountEpoch]) {
    if (value < 0n || value >= 1n << 256n) throw new Error("Invalid session integer");
  }
  return hashTypedData({
    domain: {
      name: "OpenBalanceAccount",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.account,
    },
    types: {
      SessionPayment: [
        { name: "sessionId", type: "bytes32" },
        { name: "revision", type: "uint256" },
        { name: "intentDigest", type: "bytes32" },
        { name: "accountEpoch", type: "uint256" },
      ],
    },
    primaryType: "SessionPayment",
    message: {
      sessionId: input.sessionId,
      revision: input.revision,
      intentDigest: input.intentDigest,
      accountEpoch: input.accountEpoch,
    },
  });
}
function validateOnlineSessionConfig(config: OnlineSessionConfig) {
  const uint256Limit = 1n << 256n;
  const uint48Limit = 2 ** 48;
  if (
    config.sessionId === `0x${"0".repeat(64)}` ||
    config.eventId === `0x${"0".repeat(64)}` ||
    config.maxPerPayment <= 0n ||
    config.maxPerPayment >= uint256Limit ||
    config.maxTotal < config.maxPerPayment ||
    config.maxTotal >= uint256Limit ||
    !Number.isSafeInteger(config.validAfter) ||
    !Number.isSafeInteger(config.validUntil) ||
    config.validAfter < 0 ||
    config.validUntil >= uint48Limit ||
    config.validAfter >= config.validUntil
  )
    throw new Error("Invalid online session config");
}
export type WebAuthnAuth = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};
export function encodeValidatorSignature(input: {
  purpose: Hex;
  deadline: bigint;
  backup: boolean;
  auth: WebAuthnAuth;
}): Hex {
  if (input.purpose === `0x${"0".repeat(64)}`) throw new Error("Invalid validator purpose");
  if (input.deadline < 0n || input.deadline >= 1n << 256n)
    throw new Error("Invalid validator deadline");
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bool" },
      {
        type: "tuple",
        components: [
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
        ],
      },
    ],
    [input.purpose, input.deadline, input.backup, input.auth],
  );
}
export function accountCommand(input: {
  chainId: number;
  account: Address;
  action:
    | "WITHDRAW"
    | "ROTATE"
    | "RECOVER"
    | "SET_VALIDATOR"
    | "ERC1271_CALL"
    | "PAY"
    | "CANCEL"
    | "SET_SESSION"
    | "REVOKE_SESSION"
    | "OPEN_CHANNEL";
  terms: Hex;
  epoch: bigint;
  nonce: bigint;
  deadline: bigint;
}) {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0)
    throw new Error("Invalid chain ID");
  for (const value of [input.epoch, input.nonce, input.deadline]) {
    if (value < 0n || value >= 1n << 256n) throw new Error("Invalid command integer");
  }
  return {
    domain: {
      name: "OpenBalanceAccount",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.account,
    },
    types: {
      Command: [
        { name: "action", type: "bytes32" },
        { name: "terms", type: "bytes32" },
        { name: "epoch", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Command",
    message: {
      action: keccak256(stringToHex(input.action)),
      terms: input.terms,
      epoch: input.epoch,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}
export function accountCommandDigest(input: Parameters<typeof accountCommand>[0]): Hex {
  return hashTypedData(accountCommand(input));
}
export const accountAbi = parseAbi([
  "function rpIdHash() view returns (bytes32)",
  "function origin() view returns (string)",
  "function factory() view returns (address)",
  "function epoch() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function recoveryNonce() view returns (uint256)",
  "function validators(address validator) view returns (bool)",
  "function ownership() view returns ((bytes32 x, bytes32 y) primary, (bytes32 x, bytes32 y) backup, address recovery)",
  "function sessionRevisions(bytes32 sessionId) view returns (uint256)",
  "function onlineSessionState(bytes32 sessionId) view returns (uint256 spentGross,uint256 revision,bool active,uint256 accountEpoch)",
  "function commandDigest(bytes32 action, bytes32 terms, uint256 deadline) view returns (bytes32)",
  "function setValidator(address validator, bool enabled, uint256 deadline, bool backup, (bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "function pay(address router, bytes intent, bytes terminalSignature, uint256 deadline, bool backup, (bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function cancelPayment(address router, bytes intent, bytes terminalSignature, uint256 deadline, bool backup, (bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  `function openReserveChannel(address vault,${reserveChannelTuple} config,uint256 maximumTotalReserve,uint256 deadline,bool backup,(bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)`,
  "function onlineSessionTermsHash((bytes32 sessionId,(bytes32 x,bytes32 y) signer,bytes32 eventId,address router,address asset,uint256 maxPerPayment,uint256 maxTotal,uint48 validAfter,uint48 validUntil) config) pure returns (bytes32)",
  "function sessionPaymentDigest(bytes32 sessionId,uint256 revision,bytes32 intentDigest) view returns (bytes32)",
  "function setOnlineSession((bytes32 sessionId,(bytes32 x,bytes32 y) signer,bytes32 eventId,address router,address asset,uint256 maxPerPayment,uint256 maxTotal,uint48 validAfter,uint48 validUntil) config,uint256 deadline,bool backup,(bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function revokeOnlineSession(bytes32 sessionId,uint256 expectedRevision,uint256 deadline,bool backup,(bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function payWithOnlineSession(bytes32 sessionId,bytes intent,bytes terminalSignature,bytes32 r,bytes32 s)",
  "function recover(((bytes32 x, bytes32 y) primary, (bytes32 x, bytes32 y) backup, address recovery) owners, uint256 deadline, bytes signature)",
]);

export const accountFactoryAbi = parseAbi([
  "function implementation() view returns (address)",
  "function predict(((bytes32 x,bytes32 y) primary,(bytes32 x,bytes32 y) backup,address recovery) owners,bytes32 rp,string site,bytes32 userSalt) view returns (address)",
  "function create(((bytes32 x,bytes32 y) primary,(bytes32 x,bytes32 y) backup,address recovery) owners,bytes32 rp,string site,bytes32 userSalt) returns (address)",
]);
