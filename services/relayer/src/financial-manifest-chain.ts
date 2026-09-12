import { exactPayRouterAbi, resilienceVaultAbi } from "@openbalance/protocol";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import type { FinancialEventManifest } from "./financial-manifest.js";

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

  constructor(rpcUrl: string) {
    if (!URL.canParse(rpcUrl)) throw new Error("Invalid financial manifest RPC URL");
    this.#client = createPublicClient({
      transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
    });
  }

  async assert(manifest: FinancialEventManifest): Promise<void> {
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
        this.#client.getBytecode({ address: event.router, blockTag: "finalized" }),
        this.#client.getBytecode({ address: event.vault, blockTag: "finalized" }),
        this.#client.getBytecode({ address: event.ledger, blockTag: "finalized" }),
        this.#client.readContract({
          address: event.router,
          abi: exactPayRouterAbi,
          functionName: "eventId",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.vault,
          abi: resilienceVaultAbi,
          functionName: "eventId",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.router,
          abi: routerBindingsAbi,
          functionName: "registry",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.vault,
          abi: vaultBindingsAbi,
          functionName: "registry",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "registry",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.router,
          abi: routerBindingsAbi,
          functionName: "ledger",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.vault,
          abi: vaultBindingsAbi,
          functionName: "ledger",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "router",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "vault",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.router,
          abi: routerBindingsAbi,
          functionName: "asset",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.vault,
          abi: vaultBindingsAbi,
          functionName: "asset",
          blockTag: "finalized",
        }),
        this.#client.readContract({
          address: event.ledger,
          abi: ledgerBindingsAbi,
          functionName: "asset",
          blockTag: "finalized",
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
