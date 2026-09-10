import {
  accountAbi,
  accountFactoryAbi,
  type Ownership,
  ownershipHash,
} from "@openbalance/protocol";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  sha256,
  stringToHex,
} from "viem";
import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => getAddress(value));
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);
export const accountManifestSchema = z
  .object({
    version: z.literal(1),
    chainId: z.union([z.literal(31337), z.literal(10143)]),
    factory: address,
    factoryCodeHash: hash,
    implementation: address,
    implementationCodeHash: hash,
  })
  .strict();
export type AccountManifest = z.infer<typeof accountManifestSchema>;
export type DeploymentParameters = { owners: Ownership; rpId: string; origin: string; salt: Hex };
export class DeploymentMismatch extends Error {}
export class DeploymentChain {
  readonly client: PublicClient;
  readonly manifest: AccountManifest;
  readonly manifestHash: Hex;
  constructor(manifest: unknown, rpcUrl: string) {
    this.manifest = accountManifestSchema.parse(manifest);
    this.manifestHash = keccak256(stringToHex(JSON.stringify(this.manifest)));
    const url = new URL(rpcUrl);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    )
      throw new Error("Deployment RPC requires HTTPS or loopback HTTP");
    this.client = createPublicClient({
      transport: http(rpcUrl, { timeout: 10000, retryCount: 0 }),
    });
  }

  async checkpoint() {
    if ((await this.client.getChainId()) !== this.manifest.chainId)
      throw new DeploymentMismatch("chain");
    const block = await this.client.getBlock({ blockTag: "finalized" });
    const blockNumber = block.number;
    const [factoryCode, implementationCode, implementation] = await Promise.all([
      this.client.getCode({ address: this.manifest.factory, blockNumber }),
      this.client.getCode({ address: this.manifest.implementation, blockNumber }),
      this.client.readContract({
        address: this.manifest.factory,
        abi: accountFactoryAbi,
        functionName: "implementation",
        blockNumber,
      }),
    ]);
    if (
      !factoryCode ||
      !implementationCode ||
      keccak256(factoryCode) !== this.manifest.factoryCodeHash ||
      keccak256(implementationCode) !== this.manifest.implementationCodeHash ||
      getAddress(implementation) !== this.manifest.implementation
    )
      throw new DeploymentMismatch("deployment code");
    return block;
  }

  args(parameters: DeploymentParameters) {
    return [
      parameters.owners,
      sha256(stringToHex(parameters.rpId)),
      parameters.origin,
      parameters.salt,
    ] as const;
  }
  async prepare(parameters: DeploymentParameters) {
    const block = await this.checkpoint();
    const account = await this.client.readContract({
      address: this.manifest.factory,
      abi: accountFactoryAbi,
      functionName: "predict",
      args: this.args(parameters),
      blockNumber: block.number,
    });
    return {
      account: getAddress(account),
      transaction: {
        to: this.manifest.factory,
        data: encodeFunctionData({
          abi: accountFactoryAbi,
          functionName: "create",
          args: this.args(parameters),
        }),
        value: "0x0" as const,
        chainId: `0x${this.manifest.chainId.toString(16)}`,
      },
    };
  }
  async confirm(account: Address, parameters: DeploymentParameters) {
    const block = await this.checkpoint();
    const code = await this.client.getCode({ address: account, blockNumber: block.number });
    if (!code || code === "0x") return { status: "pending" as const };
    const expected = `0x363d3d373d3d3d363d73${this.manifest.implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    if (code.toLowerCase() !== expected) throw new DeploymentMismatch("account code");
    const read = <T extends "ownership" | "epoch" | "rpIdHash" | "origin" | "factory">(
      functionName: T,
    ) =>
      this.client.readContract({
        address: account,
        abi: accountAbi,
        functionName,
        blockNumber: block.number,
      });
    const [owners, epoch, rp, origin, factory] = await Promise.all([
      read("ownership"),
      read("epoch"),
      read("rpIdHash"),
      read("origin"),
      read("factory"),
    ]);
    if (
      epoch !== 1n ||
      ownershipHash({ primary: owners[0], backup: owners[1], recovery: owners[2] }) !==
        ownershipHash(parameters.owners) ||
      rp !== sha256(stringToHex(parameters.rpId)) ||
      origin !== parameters.origin ||
      getAddress(factory) !== this.manifest.factory
    )
      throw new DeploymentMismatch("account ownership or policy");
    // Detect a changed block during the read sequence; never persist mixed snapshots.
    if ((await this.client.getBlock({ blockNumber: block.number })).hash !== block.hash)
      throw new DeploymentMismatch("checkpoint changed");
    return { status: "confirmed" as const, block: block.number.toString(), blockHash: block.hash };
  }
}
