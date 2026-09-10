import { zeroAddress, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import { accountCommandDigest, ownershipHash, withdrawalHash } from "../src/accounts.js";

const command = {
  chainId: 10143,
  account: "0x0000000000000000000000000000000000000001" as const,
  action: "RECOVER" as const,
  terms: zeroHash,
  epoch: 1n,
  nonce: 0n,
  deadline: 1000n,
};
describe("account command domains", () => {
  it("binds every domain and authority field", () => {
    const digest = accountCommandDigest(command);
    for (const mutation of [
      { chainId: 143 },
      { account: zeroAddress },
      { action: "ROTATE" as const },
      {
        terms: ownershipHash({
          primary: { x: zeroHash, y: zeroHash },
          backup: { x: zeroHash, y: zeroHash },
          recovery: zeroAddress,
        }),
      },
      { epoch: 2n },
      { nonce: 1n },
      { deadline: 1001n },
    ])
      expect(accountCommandDigest({ ...command, ...mutation })).not.toBe(digest);
  });
  it("rejects invalid integer ranges and distinguishes exact withdrawal amounts", () => {
    expect(() => accountCommandDigest({ ...command, nonce: -1n })).toThrow();
    expect(() => accountCommandDigest({ ...command, deadline: 1n << 256n })).toThrow();
    expect(withdrawalHash(zeroAddress, command.account, 1n)).not.toBe(
      withdrawalHash(zeroAddress, command.account, 2n),
    );
  });
});
