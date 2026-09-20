import { exactPayRouterAbi, resilienceVaultAbi } from "@openbalance/protocol";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";

export type FinancialManifestFinalityTag = "finalized" | "safe" | "latest";

const routerBindingsAbi = parseAbi([
  "function registry() view returns (address)",
  "function ledger() view returns (address)",
  "function asset() view returns (address)",
]);
const vaultBindingsAbi = parseAbi([
  "function registry() view returns (address)",
  "function ledger() view returns (address)",
  "function asset() view returns (address)",
]);
const ledgerBindingsAbi = parseAbi([
  "function registry() view returns (address)",
  "function router() view returns (address)",
  "function vault() view returns (address)",
  "function asset() view returns (address)",
]);

/** Fails startup unless every configured event is a coherent finalized contract deployment. */
export class ViemFinancialManifestVerifier {
  readonly #client;
  readonly #finalityTag: FinancialManifestFinalityTag;

  constructor(rpcUrl: string, finalityTag: FinancialManifestFinalityTag = "finalized") {
    if (!URL.canParse(rpcUrl)) throw new Error("Invalid financial manifest RPC URL");
    this.#client = createPublicClient({
      transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
    this.#finalityTag = finalityTag;
  }

  async assert(manifest: FinancialEventManifest): Promise<void> {
    const blockTag = this.#finalityTag;
    if ((await this.#client.getChainId()) !== manifest.chainId)
      throw new Error("Financial manifest chain ID does not match RPC");
    for (const event of manifest.events) {
      const [
        routerCode,
        vaultCode,
        ledgerCode,
        routerEvent,
        vaultEvent,
        routerRegistry,
        vaultRegistry,
        ledgerRegistry,
        routerLedger,
        vaultLedger,
        ledgerRouter,
        ledgerVault,
        routerAsset,
        vaultAsset,
        ledgerAsset,
      ] = await Promise.all([
        this.#client.getBytecode({ address: event.router, blockTag }),
        this.#client.getBytecode({ address: event.vault, blockTag }),
        this.#client.getBytecode({ address: event.ledger, blockTag }),
        this.#client.readContract({
          address: event.router,
          abi: exactPayRouterAbi,
          functionName: "eventId",
          blockTag,
        }),
        this.#client.readContract({
          address: event.vault,
          abi: resilienceVaultAbi,
          functionName: "eventId",
          blockTag,
        }),
        this.#client.readContract({
          address: event.router,
          abi: routerBindingsAbi,
          functionName: "registry",
          blockTag,
        }),
        this.#client.readContract({
          address: event.vault,
          abi: vaultBindingsAbi,
          functionName: "registry",
          blockTag,
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "registry",
          blockTag,
        }),
        this.#client.readContract({
          address: event.router,
          abi: routerBindingsAbi,
          functionName: "ledger",
          blockTag,
        }),
        this.#client.readContract({
          address: event.vault,
          abi: vaultBindingsAbi,
          functionName: "ledger",
          blockTag,
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "router",
          blockTag,
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "vault",
          blockTag,
        }),
        this.#client.readContract({
          address: event.router,
          abi: routerBindingsAbi,
          functionName: "asset",
          blockTag,
        }),
        this.#client.readContract({
          address: event.vault,
          abi: vaultBindingsAbi,
          functionName: "asset",
          blockTag,
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "asset",
          blockTag,
        }),
      ]);
      if (
        !routerCode ||
        !vaultCode ||
        !ledgerCode ||
        routerEvent.toLowerCase() !== event.eventId ||
        vaultEvent.toLowerCase() !== event.eventId ||
        getAddress(routerRegistry) !== getAddress(vaultRegistry) ||
        getAddress(routerRegistry) !== getAddress(ledgerRegistry) ||
        getAddress(routerLedger) !== event.ledger ||
        getAddress(vaultLedger) !== event.ledger ||
        getAddress(ledgerRouter) !== event.router ||
        getAddress(ledgerVault) !== event.vault ||
        getAddress(routerAsset) !== event.asset ||
        getAddress(vaultAsset) !== event.asset ||
        getAddress(ledgerAsset) !== event.asset
      )
        throw new Error("Financial event manifest does not match finalized contracts");
    }
  }
}
