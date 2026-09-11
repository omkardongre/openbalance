import {
  type Address,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";

export type Ownership = {
  primary: { x: Hex; y: Hex };
  backup: { x: Hex; y: Hex };
  recovery: Address;
};
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
  action: "WITHDRAW" | "ROTATE" | "RECOVER" | "SET_VALIDATOR" | "ERC1271_CALL" | "PAY" | "CANCEL";
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
  "function commandDigest(bytes32 action, bytes32 terms, uint256 deadline) view returns (bytes32)",
  "function setValidator(address validator, bool enabled, uint256 deadline, bool backup, (bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "function pay(address router, bytes intent, bytes terminalSignature, uint256 deadline, bool backup, (bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function cancelPayment(address router, bytes intent, bytes terminalSignature, uint256 deadline, bool backup, (bytes32 r,bytes32 s,uint256 challengeIndex,uint256 typeIndex,bytes authenticatorData,string clientDataJSON) auth)",
  "function recover(((bytes32 x, bytes32 y) primary, (bytes32 x, bytes32 y) backup, address recovery) owners, uint256 deadline, bytes signature)",
]);

export const accountFactoryAbi = parseAbi([
  "function implementation() view returns (address)",
  "function predict(((bytes32 x,bytes32 y) primary,(bytes32 x,bytes32 y) backup,address recovery) owners,bytes32 rp,string site,bytes32 userSalt) view returns (address)",
  "function create(((bytes32 x,bytes32 y) primary,(bytes32 x,bytes32 y) backup,address recovery) owners,bytes32 rp,string site,bytes32 userSalt) returns (address)",
]);
