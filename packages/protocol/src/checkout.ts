import { type Hex, keccak256, stringToHex } from "viem";
import { z } from "zod";
import { decodePaymentIntent, type PaymentIntent } from "./payments.js";

const hexSignature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const unsigned = z.string().regex(/^(0|[1-9][0-9]*)$/);
const boundedLabel = z
  .string()
  .min(1)
  .max(160)
  .refine((value) =>
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    }),
  );

const schema = z
  .object({
    schemaVersion: z.literal(1),
    orderId: z.string().uuid(),
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

const resolvedSchema = z
  .object({
    schemaVersion: z.literal(1),
    orderId: z.string().uuid(),
    encodedIntent: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),
    terminalSignature: hexSignature,
    display: z
      .object({
        vendorName: boundedLabel,
        orderReference: boundedLabel,
        orderVersion: unsigned,
        description: boundedLabel,
        assetSymbol: z.string().regex(/^[A-Z0-9]{2,12}$/),
        assetDecimals: z.number().int().min(0).max(36),
      })
      .strict(),
    reservePolicy: z
      .object({
        vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        terminalSigner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        maximumReserveUnits: unsigned,
        maximumPerVoucherUnits: unsigned,
        maximumVoucherCount: z.number().int().min(1).max(10_000),
        acceptanceDurationSeconds: z.number().int().min(60).max(86_400),
        submissionDelaySeconds: z.number().int().min(60).max(604_800),
      })
      .strict(),
  })
  .strict();

export type CheckoutCapability = z.infer<typeof schema>;
export type ResolvedCheckoutRequest = Omit<z.infer<typeof resolvedSchema>, "encodedIntent"> & {
  encodedIntent: Hex;
  terminalSignature: Hex;
  intent: PaymentIntent;
};

export function orderReferenceHash(reference: string, version: bigint): Hex {
  if (!boundedLabel.safeParse(reference).success || version < 1n)
    throw new Error("Invalid checkout order reference");
  return keccak256(stringToHex(`openbalance:order:v1:${reference}:${version.toString()}`));
}

export function receiptCommitment(input: {
  vendorName: string;
  orderReference: string;
  orderVersion: bigint;
  description: string;
  assetSymbol: string;
  assetDecimals: number;
  grossUnits: bigint;
}): Hex {
  const display = {
    vendorName: input.vendorName,
    orderReference: input.orderReference,
    orderVersion: input.orderVersion.toString(),
    description: input.description,
    assetSymbol: input.assetSymbol,
    assetDecimals: input.assetDecimals,
  };
  const checked = resolvedSchema.shape.display.safeParse(display);
  if (!checked.success || input.grossUnits < 1n)
    throw new Error("Invalid checkout receipt commitment");
  return keccak256(
    stringToHex(
      JSON.stringify({
        schemaVersion: 1,
        ...checked.data,
        grossUnits: input.grossUnits.toString(),
      }),
    ),
  );
}

export function encodeCheckoutCapability(value: CheckoutCapability): string {
  return JSON.stringify(schema.parse(value));
}

export function decodeCheckoutCapability(value: string): CheckoutCapability {
  if (value.length > 512) throw new Error("Checkout capability is too large");
  return schema.parse(JSON.parse(value));
}

export function decodeResolvedCheckoutRequest(value: unknown): ResolvedCheckoutRequest {
  const parsed = resolvedSchema.parse(value);
  const intent = decodePaymentIntent(parsed.encodedIntent as Hex);
  const orderVersion = BigInt(parsed.display.orderVersion);
  if (
    intent.orderRefHash.toLowerCase() !==
      orderReferenceHash(parsed.display.orderReference, orderVersion).toLowerCase() ||
    intent.receiptCommitment.toLowerCase() !==
      receiptCommitment({
        ...parsed.display,
        orderVersion,
        grossUnits: intent.grossUnits,
      }).toLowerCase()
  )
    throw new Error("Checkout display does not match the signed payment intent");
  return {
    ...parsed,
    encodedIntent: parsed.encodedIntent as Hex,
    terminalSignature: parsed.terminalSignature as Hex,
    intent,
  };
}
