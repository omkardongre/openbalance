import { eventRegistryAbi } from "@openbalance/protocol";
import { createPublicClient, getAddress, type Hex, http, type PublicClient } from "viem";
import type { CheckoutEventPolicy } from "./checkout-manifest.js";
import type { StallChain, StallRegistryView } from "./stall-onboarding.js";

/** Reads one stall's registry entries at the latest finalized block. */
export class ViemStallChain implements StallChain {
  readonly #client: PublicClient;

  constructor(rpcUrl: string) {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))
      throw new Error("Stall registry RPC transport must use HTTPS");
    this.#client = createPublicClient({
      transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }),
    });
  }

  async read(
    event: CheckoutEventPolicy & { chainId: number },
    query: { vendorId: Hex; destinationVersion: bigint; terminalId: Hex; terminalVersion: bigint },
  ): Promise<StallRegistryView> {
    const block = await this.#client.getBlock({ blockTag: "finalized" });
    const blockNumber = block.number;
    const read = <T>(functionName: string, args: readonly unknown[]) =>
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: functionName as never,
        args: args as never,
        blockNumber,
      }) as Promise<T>;
    const [chainId, vendor, destination, terminal, config] = await Promise.all([
      this.#client.getChainId(),
      read<readonly [`0x${string}`, boolean]>("vendors", [query.vendorId]),
      read<readonly [`0x${string}`, boolean]>("destinations", [
        query.vendorId,
        query.destinationVersion,
      ]),
      read<readonly [Hex, `0x${string}`, number, number, boolean]>("terminals", [
        query.terminalId,
        query.terminalVersion,
      ]),
      read<readonly [number, number, number, number, number, number, string, string, Hex, boolean]>(
        "configs",
        [event.configVersion],
      ),
    ]);
    if (chainId !== event.chainId) throw new Error("Stall registry RPC is on the wrong chain");
    return {
      vendor: { authority: getAddress(vendor[0]), enabled: vendor[1] },
      destination: { account: getAddress(destination[0]), enabled: destination[1] },
      terminal: {
        vendorId: terminal[0].toLowerCase() as Hex,
        signer: getAddress(terminal[1]),
        validAfter: Number(terminal[2]),
        validUntil: Number(terminal[3]),
        enabled: terminal[4],
      },
      config: { validAfter: Number(config[0]), validUntil: Number(config[1]), enabled: config[9] },
    };
  }
}
