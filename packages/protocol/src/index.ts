import { z } from "zod";

export * from "./accounts.js";
export * from "./checkout.js";
export * from "./offline-exchange.js";
export * from "./payments.js";
export * from "./terminal.js";

export const monadChains = {
  mainnet: 143,
  testnet: 10_143,
} as const;

export const baseUnitAmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "amount must be an unsigned base-unit integer");

export type BaseUnitAmount = z.infer<typeof baseUnitAmountSchema>;
