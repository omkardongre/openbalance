import { readFile } from "node:fs/promises";
import { type Address, getAddress, type Hex } from "viem";
import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const positive = z.string().regex(/^[1-9][0-9]*$/);
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    chainId: z.number().int().positive().safe(),
    events: z
      .array(
        z
          .object({
            streamId: z.string().min(3).max(255),
            eventId: bytes32,
            router: address,
            registry: address,
            ledger: address,
            vault: address,
            runtimeCodeHashes: z
              .object({
                registry: bytes32,
                ledger: bytes32,
                router: bytes32,
                vault: bytes32,
              })
              .strict(),
            asset: address,
            assetSymbol: z.string().regex(/^[A-Z0-9]{2,12}$/),
            assetDecimals: z.number().int().min(0).max(36),
            configVersion: positive,
            organizerFeeBps: z.number().int().min(0).max(10_000),
            platformFeeBps: z.number().int().min(0).max(10_000),
            intentLifetimeSeconds: z.number().int().min(60).max(3_600),
            vendors: z
              .array(
                z
                  .object({
                    vendorId: bytes32,
                    vendorName: z.string().min(1).max(160),
                    destinationVersion: positive,
                    terminal: z
                      .object({
                        instanceId: bytes32,
                        keyVersion: positive,
                        signer: address,
                      })
                      .strict(),
                    reservePolicy: z
                      .object({
                        maximumReserveUnits: positive,
                        maximumPerVoucherUnits: positive,
                        maximumVoucherCount: z.number().int().min(1).max(10_000),
                        acceptanceDurationSeconds: z.number().int().min(60).max(86_400),
                        submissionDelaySeconds: z.number().int().min(60).max(604_800),
                      })
                      .strict(),
                  })
                  .strict(),
              )
              .max(1_000),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict();

export type CheckoutVendorPolicy = {
  vendorId: Hex;
  vendorName: string;
  destinationVersion: bigint;
  terminal: { instanceId: Hex; keyVersion: bigint; signer: Address };
  reservePolicy: {
    maximumReserveUnits: bigint;
    maximumPerVoucherUnits: bigint;
    maximumVoucherCount: number;
    acceptanceDurationSeconds: number;
    submissionDelaySeconds: number;
  };
};

export type CheckoutEventPolicy = {
  streamId: string;
  eventId: Hex;
  router: Address;
  registry: Address;
  ledger: Address;
  vault: Address;
  runtimeCodeHashes: { registry: Hex; ledger: Hex; router: Hex; vault: Hex };
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  configVersion: bigint;
  organizerFeeBps: number;
  platformFeeBps: number;
  intentLifetimeSeconds: number;
  vendors: CheckoutVendorPolicy[];
};

export type CheckoutManifest = { schemaVersion: 1; chainId: number; events: CheckoutEventPolicy[] };

export async function loadCheckoutManifest(path: string): Promise<CheckoutManifest> {
  const parsed = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const events = parsed.events.map((event) => ({
    ...event,
    eventId: event.eventId.toLowerCase() as Hex,
    router: getAddress(event.router),
    registry: getAddress(event.registry),
    ledger: getAddress(event.ledger),
    vault: getAddress(event.vault),
    runtimeCodeHashes: {
      registry: event.runtimeCodeHashes.registry.toLowerCase() as Hex,
      ledger: event.runtimeCodeHashes.ledger.toLowerCase() as Hex,
      router: event.runtimeCodeHashes.router.toLowerCase() as Hex,
      vault: event.runtimeCodeHashes.vault.toLowerCase() as Hex,
    },
    asset: getAddress(event.asset),
    configVersion: BigInt(event.configVersion),
    vendors: event.vendors.map((vendor) => ({
      ...vendor,
      vendorId: vendor.vendorId.toLowerCase() as Hex,
      destinationVersion: BigInt(vendor.destinationVersion),
      terminal: {
        instanceId: vendor.terminal.instanceId.toLowerCase() as Hex,
        keyVersion: BigInt(vendor.terminal.keyVersion),
        signer: getAddress(vendor.terminal.signer),
      },
      reservePolicy: {
        ...vendor.reservePolicy,
        maximumReserveUnits: BigInt(vendor.reservePolicy.maximumReserveUnits),
        maximumPerVoucherUnits: BigInt(vendor.reservePolicy.maximumPerVoucherUnits),
      },
    })),
  }));
  if (
    new Set(events.map((event) => `${event.streamId}:${event.eventId}`)).size !== events.length ||
    events.some(
      (event) =>
        event.organizerFeeBps + event.platformFeeBps > 10_000 ||
        new Set(event.vendors.map((vendor) => vendor.vendorId)).size !== event.vendors.length ||
        event.vendors.some(
          (vendor) =>
            vendor.reservePolicy.maximumPerVoucherUnits > vendor.reservePolicy.maximumReserveUnits,
        ),
    )
  )
    throw new Error("Checkout manifest contains conflicting event policy");
  return { schemaVersion: 1, chainId: parsed.chainId, events };
}
