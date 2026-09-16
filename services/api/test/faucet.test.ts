import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  type FaucetChain,
  FaucetExhausted,
  type FaucetLedger,
  FaucetRejected,
  FaucetService,
} from "../src/faucet.js";

const account = "0x00000000000000000000000000000000000000aa" as Address;

class MemoryLedger implements FaucetLedger {
  reservations: { id: string; amount: bigint; status: string; hash?: string }[] = [];
  async reserve(_chainId: number, _account: Address, amount: bigint, dailyLimit: bigint) {
    const total = this.reservations
      .filter((entry) => entry.status !== "FAILED")
      .reduce((sum, entry) => sum + entry.amount, 0n);
    if (total + amount > dailyLimit) throw new FaucetExhausted();
    const id = String(this.reservations.length + 1);
    this.reservations.push({ id, amount, status: "PENDING" });
    return id;
  }
  async complete(id: string, hash: Hex) {
    const entry = this.reservations.find((value) => value.id === id);
    if (entry) {
      entry.status = "GRANTED";
      entry.hash = hash;
    }
  }
  async fail(id: string) {
    const entry = this.reservations.find((value) => value.id === id);
    if (entry) entry.status = "FAILED";
  }
}

class FakeChain implements FaucetChain {
  balances = new Map<string, bigint>();
  failAt: "transfer" | null = null;
  async balanceOf(target: Address) {
    return this.balances.get(target.toLowerCase()) ?? 0n;
  }
  async transfer(target: Address, amount: bigint) {
    if (this.failAt === "transfer") throw new Error("transfer reverted");
    this.balances.set(
      target.toLowerCase(),
      (this.balances.get(target.toLowerCase()) ?? 0n) + amount,
    );
    return `0x${"ab".repeat(32)}` as Hex;
  }
  async awaitSuccess() {}
}

function service(maxAmount = 10n, dailyLimit = 20n) {
  const ledger = new MemoryLedger();
  const chain = new FakeChain();
  return {
    ledger,
    chain,
    faucet: new FaucetService(ledger, chain, {
      chainId: 31_337,
      token: account,
      maxAmount,
      dailyLimit,
    }),
  };
}

describe("FaucetService", () => {
  it("grants the exact amount and records the completed grant", async () => {
    const { faucet, chain, ledger } = service();
    const result = await faucet.fund(account, 6n);
    expect(result.amount).toBe("6");
    expect(await chain.balanceOf(account)).toBe(6n);
    expect(ledger.reservations[0]).toMatchObject({
      status: "GRANTED",
      hash: result.transactionHash,
    });
  });

  it("rejects an amount above the per-request maximum without reserving budget", async () => {
    const { faucet, ledger } = service(10n, 20n);
    await expect(faucet.fund(account, 11n)).rejects.toBeInstanceOf(FaucetRejected);
    expect(ledger.reservations).toHaveLength(0);
  });

  it("enforces the daily cap across grants", async () => {
    const { faucet } = service(10n, 12n);
    await faucet.fund(account, 10n);
    await expect(faucet.fund(account, 10n)).rejects.toBeInstanceOf(FaucetExhausted);
  });

  it("marks the reservation failed when the transfer reverts", async () => {
    const { faucet, chain, ledger } = service();
    chain.failAt = "transfer";
    await expect(faucet.fund(account, 5n)).rejects.toBeInstanceOf(FaucetRejected);
    expect(ledger.reservations[0]?.status).toBe("FAILED");
  });
});
