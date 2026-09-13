import { eventRegistryAbi, exactPayRouterAbi, type PaymentIntent } from "@openbalance/protocol";
import { createPublicClient, getAddress, http } from "viem";
import type { CheckoutEventPolicy, CheckoutVendorPolicy } from "./checkout-manifest.js";

export type CheckoutPolicyVerifier = {
  assert(
    event: CheckoutEventPolicy,
    vendor: CheckoutVendorPolicy,
    intent: PaymentIntent,
  ): Promise<void>;
};

export class ViemCheckoutPolicyVerifier implements CheckoutPolicyVerifier {
  readonly #client;
  constructor(rpcUrl: string) {
    const url = new URL(rpcUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))
      throw new Error("Checkout RPC transport must use HTTPS");
    this.#client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000 }) });
  }

  async assert(
    event: CheckoutEventPolicy,
    vendor: CheckoutVendorPolicy,
    intent: PaymentIntent,
  ): Promise<void> {
    const block = await this.#client.getBlock({ blockTag: "finalized" });
    const blockNumber = block.number;
    const [
      chainId,
      routerEvent,
      routerAsset,
      routerRegistry,
      registryEvent,
      registryAsset,
      config,
      destination,
      terminal,
      onlinePaused,
    ] = await Promise.all([
      this.#client.getChainId(),
      this.#client.readContract({
        address: event.router,
        abi: exactPayRouterAbi,
        functionName: "eventId",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.router,
        abi: exactPayRouterAbi,
        functionName: "asset",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.router,
        abi: exactPayRouterAbi,
        functionName: "registry",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "eventId",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "asset",
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "configs",
        args: [event.configVersion],
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "destinations",
        args: [vendor.vendorId, vendor.destinationVersion],
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "terminals",
        args: [vendor.terminal.instanceId, vendor.terminal.keyVersion],
        blockNumber,
      }),
      this.#client.readContract({
        address: event.registry,
        abi: eventRegistryAbi,
        functionName: "onlinePaused",
        blockNumber,
      }),
    ]);
    const now = block.timestamp;
    const intentStart = BigInt(intent.validAfter);
    const clockSkew = now > intentStart ? now - intentStart : intentStart - now;
    if (
      chainId !== Number(intent.chainId) ||
      routerEvent.toLowerCase() !== event.eventId ||
      registryEvent.toLowerCase() !== event.eventId ||
      getAddress(routerAsset) !== event.asset ||
      getAddress(registryAsset) !== event.asset ||
      getAddress(routerRegistry) !== event.registry ||
      clockSkew > 120n ||
      config[0] > intentStart ||
      config[1] < BigInt(intent.expiresAt) ||
      config[2] !== event.organizerFeeBps ||
      config[3] !== event.platformFeeBps ||
      BigInt(vendor.reservePolicy.acceptanceDurationSeconds) > config[4] ||
      BigInt(vendor.reservePolicy.submissionDelaySeconds) > config[5] ||
      !config[9] ||
      !destination[1] ||
      terminal[0].toLowerCase() !== vendor.vendorId ||
      getAddress(terminal[1]) !== vendor.terminal.signer ||
      terminal[2] > intentStart ||
      terminal[3] < BigInt(intent.expiresAt) ||
      !terminal[4] ||
      onlinePaused
    )
      throw new Error("Checkout manifest does not match finalized event policy");
  }
}
