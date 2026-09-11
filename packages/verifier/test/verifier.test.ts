import { exactPayRouterAbi } from "@openbalance/protocol";
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  keccak256,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  type DeploymentManifest,
  VerificationFailed,
  type VerificationReader,
  verifyCustodyConservation,
  verifyDeployment,
  verifyFinalizedTransition,
} from "../src/index.js";

const address = (suffix: string) => `0x${suffix.padStart(40, "0")}` as Address;
const hex32 = (suffix: string) => `0x${suffix.padStart(64, "0")}` as Hex;
const code = (byte: string) => `0x${byte.repeat(8)}` as Hex;

const manifest: DeploymentManifest = {
  chainId: 10143,
  eventId: hex32("e1"),
  asset: address("a1"),
  registry: { address: address("11"), runtimeCodeHash: keccak256(code("11")) },
  ledger: { address: address("12"), runtimeCodeHash: keccak256(code("12")) },
  router: { address: address("13"), runtimeCodeHash: keccak256(code("13")) },
  vault: { address: address("14"), runtimeCodeHash: keccak256(code("14")) },
};

class Reader implements VerificationReader {
  chainId = 10143;
  finalized = 100n;
  canonicalHash = hex32("b1");
  receipt?: TransactionReceipt;
  readonly code = new Map<Address, Hex>([
    [manifest.registry.address, code("11")],
    [manifest.ledger.address, code("12")],
    [manifest.router.address, code("13")],
    [manifest.vault.address, code("14")],
  ]);
  readonly values = new Map<string, unknown>();

  constructor() {
    this.values.set(`${manifest.registry.address}:eventId`, manifest.eventId);
    this.values.set(`${manifest.registry.address}:asset`, manifest.asset);
    this.values.set(`${manifest.ledger.address}:registry`, manifest.registry.address);
    this.values.set(`${manifest.ledger.address}:asset`, manifest.asset);
    this.values.set(`${manifest.ledger.address}:router`, manifest.router.address);
    this.values.set(`${manifest.ledger.address}:vault`, manifest.vault.address);
    this.values.set(`${manifest.router.address}:registry`, manifest.registry.address);
    this.values.set(`${manifest.router.address}:ledger`, manifest.ledger.address);
    this.values.set(`${manifest.router.address}:asset`, manifest.asset);
    this.values.set(`${manifest.vault.address}:registry`, manifest.registry.address);
    this.values.set(`${manifest.vault.address}:ledger`, manifest.ledger.address);
    this.values.set(`${manifest.vault.address}:asset`, manifest.asset);
  }

  async getChainId() {
    return this.chainId;
  }
  async getBytecode(input: { address: Address }) {
    return this.code.get(input.address);
  }
  async getTransactionReceipt() {
    if (!this.receipt) throw new Error("missing receipt");
    return this.receipt;
  }
  async getBlock(input: { blockTag: "finalized" } | { blockNumber: bigint }) {
    return "blockTag" in input
      ? { number: this.finalized, hash: hex32("ff") }
      : { number: input.blockNumber, hash: this.canonicalHash };
  }
  async readContract(input: { address: Address; functionName: string; args?: readonly unknown[] }) {
    const suffix = input.args ? `:${String(input.args[0])}` : "";
    return this.values.get(`${input.address}:${input.functionName}${suffix}`);
  }
}

function paymentReceipt(): TransactionReceipt {
  const paymentId = hex32("21");
  const payer = address("22");
  const vendorId = hex32("23");
  const topics = encodeEventTopics({
    abi: exactPayRouterAbi,
    eventName: "PaymentCommitted",
    args: { paymentId, payer, vendorId },
  });
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [1n, 10_000n, 200n, 100n, hex32("24")],
  );
  return {
    status: "success",
    transactionHash: hex32("31"),
    blockNumber: 90n,
    blockHash: hex32("b1"),
    logs: [
      {
        address: manifest.router.address,
        topics,
        data,
        logIndex: 2,
      },
    ],
  } as unknown as TransactionReceipt;
}

describe("independent verifier", () => {
  it("verifies deployment code and immutable cross-bindings at finalized state", async () => {
    const reader = new Reader();
    await expect(verifyDeployment(reader, manifest)).resolves.toEqual({
      chainId: 10143,
      finalizedBlockNumber: 100n,
      finalizedBlockHash: hex32("ff"),
    });
    reader.code.set(manifest.vault.address, code("99"));
    await expect(verifyDeployment(reader, manifest)).rejects.toThrow("vault code mismatch");
  });

  it("verifies a canonical finalized payment event and every expected field", async () => {
    const reader = new Reader();
    reader.receipt = paymentReceipt();
    await expect(
      verifyFinalizedTransition(reader, {
        kind: "payment",
        contract: manifest.router.address,
        transactionHash: hex32("31"),
        paymentId: hex32("21"),
        payer: address("22"),
        vendorId: hex32("23"),
        gross: 10_000n,
      }),
    ).resolves.toMatchObject({ blockNumber: 90n, logIndex: 2 });

    await expect(
      verifyFinalizedTransition(reader, {
        kind: "payment",
        contract: manifest.router.address,
        transactionHash: hex32("31"),
        paymentId: hex32("21"),
        payer: address("22"),
        vendorId: hex32("23"),
        gross: 10_001n,
      }),
    ).rejects.toThrow("gross mismatch");
  });

  it("rejects unfinalized and noncanonical receipts", async () => {
    const reader = new Reader();
    reader.receipt = paymentReceipt();
    reader.finalized = 80n;
    const expected = {
      kind: "payment" as const,
      contract: manifest.router.address,
      transactionHash: hex32("31"),
      paymentId: hex32("21"),
      payer: address("22"),
      vendorId: hex32("23"),
      gross: 10_000n,
    };
    await expect(verifyFinalizedTransition(reader, expected)).rejects.toThrow(
      "transaction is not finalized",
    );
    reader.finalized = 100n;
    reader.canonicalHash = hex32("dead");
    await expect(verifyFinalizedTransition(reader, expected)).rejects.toThrow(
      "transaction block is not canonical",
    );
  });

  it("checks ledger and reserve custody against finalized liabilities", async () => {
    const reader = new Reader();
    reader.values.set(`${manifest.asset}:balanceOf:${manifest.ledger.address}`, 12_000n);
    reader.values.set(`${manifest.ledger.address}:totalLiability`, 12_000n);
    reader.values.set(`${manifest.asset}:balanceOf:${manifest.vault.address}`, 8_000n);
    reader.values.set(`${manifest.vault.address}:totalReserved`, 8_000n);
    await expect(verifyCustodyConservation(reader, manifest)).resolves.toEqual({
      ledgerUnits: 12_000n,
      vaultUnits: 8_000n,
    });
    reader.values.set(`${manifest.vault.address}:totalReserved`, 8_001n);
    await expect(verifyCustodyConservation(reader, manifest)).rejects.toBeInstanceOf(
      VerificationFailed,
    );
  });
});
