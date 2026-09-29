import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  FaucetAccountLimit,
  type FaucetChain,
  FaucetDepleted,
  FaucetExhausted,
  type FaucetLedger,
  FaucetRejected,
  FaucetService,
} from "../src/faucet.js";

const account = "0x00000000000000000000000000000000000000aa" as Address;
const other = "0x00000000000000000000000000000000000000bb" as Address;

class MemoryLedger implements FaucetLedger {
  reservations: { id: string; account: string; amount: bigint; status: string; hash?: string }[] =
    [];
  async reserve(
    _chainId: number,
    target: Address,
    amount: bigint,
    limits: { daily: bigint; perAccount: bigint },
  ) {
    const live = this.reservations.filter((entry) => entry.status !== "FAILED");
    const sum = (entries: typeof live) =>
      entries.reduce((total, entry) => total + entry.amount, 0n);
    if (sum(live.filter((entry) => entry.account === target)) + amount > limits.perAccount)
      throw new FaucetAccountLimit();
    if (sum(live) + amount > limits.daily) throw new FaucetExhausted();
    const id = String(this.reservations.length + 1);
    this.reservations.push({ id, account: target, amount, status: "PENDING" });
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
  pool = 1_000n;
  failAt: "transfer" | null = null;
  async balanceOf(target: Address) {
    return this.balances.get(target.toLowerCase()) ?? 0n;
  }
  async reserveBalance() {
    return this.pool;
  }
  async transfer(target: Address, amount: bigint) {
    if (this.failAt === "transfer") throw new Error("transfer reverted");
    this.pool -= amount;
    this.balances.set(
      target.toLowerCase(),
      (this.balances.get(target.toLowerCase()) ?? 0n) + amount,
    );
    return `0x${"ab".repeat(32)}` as Hex;
  }
  async awaitSuccess() {}
}

function service(maxAmount = 10n, dailyLimit = 40n, accountLimit = 20n) {
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
      accountLimit,
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
    const { faucet, ledger } = service();
    await expect(faucet.fund(account, 11n)).rejects.toBeInstanceOf(FaucetRejected);
    expect(ledger.reservations).toHaveLength(0);
  });

  it("caps one account's lifetime total while others can still draw", async () => {
    const { faucet } = service(10n, 40n, 15n);
    await faucet.fund(account, 10n);
    await expect(faucet.fund(account, 10n)).rejects.toBeInstanceOf(FaucetAccountLimit);
    await expect(faucet.fund(other, 10n)).resolves.toMatchObject({ amount: "10" });
  });

  it("enforces the daily cap across accounts", async () => {
    const { faucet } = service(10n, 15n, 20n);
    await faucet.fund(account, 10n);
    await expect(faucet.fund(other, 10n)).rejects.toBeInstanceOf(FaucetExhausted);
  });

  it("refuses before reserving or sending when the faucet wallet cannot cover the grant", async () => {
    const { faucet, chain, ledger } = service();
    chain.pool = 4n;
    await expect(faucet.fund(account, 5n)).rejects.toBeInstanceOf(FaucetDepleted);
    expect(ledger.reservations).toHaveLength(0);
  });

  it("marks the reservation failed when the transfer reverts", async () => {
    const { faucet, chain, ledger } = service();
    chain.failAt = "transfer";
    await expect(faucet.fund(account, 5n)).rejects.toBeInstanceOf(FaucetRejected);
    expect(ledger.reservations[0]?.status).toBe("FAILED");
  });
});
