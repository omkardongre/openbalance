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
export function accountCommand(input: {
  chainId: number;
  account: Address;
  action: "WITHDRAW" | "ROTATE" | "RECOVER";
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
  "function epoch() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function recoveryNonce() view returns (uint256)",
  "function ownership() view returns ((bytes32 x, bytes32 y) primary, (bytes32 x, bytes32 y) backup, address recovery)",
  "function commandDigest(bytes32 action, bytes32 terms, uint256 deadline) view returns (bytes32)",
  "function recover(((bytes32 x, bytes32 y) primary, (bytes32 x, bytes32 y) backup, address recovery) owners, uint256 deadline, bytes signature)",
]);
