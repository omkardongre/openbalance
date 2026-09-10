import { describe, expect, it } from "vitest";

import { baseUnitAmountSchema, monadChains } from "../src/index.js";

describe("protocol primitives", () => {
  it("pins the supported Monad networks", () => {
    expect(monadChains).toEqual({ mainnet: 143, testnet: 10_143 });
  });

  it.each(["0", "1", "1000000"])("accepts exact base-unit amount %s", (amount) => {
    expect(baseUnitAmountSchema.parse(amount)).toBe(amount);
  });

  it.each(["", "01", "-1", "1.5", "1e6"])("rejects ambiguous amount %s", (amount) => {
    expect(baseUnitAmountSchema.safeParse(amount).success).toBe(false);
  });
});
