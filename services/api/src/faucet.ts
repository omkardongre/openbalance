import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import type { Chain } from "viem";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);

export class FaucetRejected extends Error {
  override readonly name = "FaucetRejected";
}
export class FaucetExhausted extends Error {
  override readonly name = "FaucetExhausted";
}

/** Minimal chain boundary so the faucet cap logic is testable without a live node. */
export interface FaucetChain {
  balanceOf(account: Address): Promise<bigint>;
  transfer(account: Address, amount: bigint): Promise<Hex>;
  awaitSuccess(hash: Hex): Promise<void>;
}

/** Durable budget boundary; reservations count against the cap before any transfer is sent. */
export interface FaucetLedger {
  reserve(chainId: number, account: Address, amount: bigint, dailyLimit: bigint): Promise<string>;
  complete(id: string, transactionHash: Hex): Promise<void>;
  fail(id: string, reason: string): Promise<void>;
}

export type FaucetOptions = {
  chainId: number;
  token: Address;
  maxAmount: bigint;
  dailyLimit: bigint;
};

/**
 * Bounded test-asset faucet. It grants only the caller's own authenticated account, enforces a
 * per-request maximum and a daily cap, verifies the exact balance increase on chain, and records
 * every grant durably. It is a test-only funding source and is never presented as card funding.
 */
export class FaucetService {
  readonly #ledger: FaucetLedger;
  readonly #chain: FaucetChain;
  readonly #options: FaucetOptions;

  constructor(ledger: FaucetLedger, chain: FaucetChain, options: FaucetOptions) {
    if (options.maxAmount <= 0n || options.dailyLimit < options.maxAmount)
      throw new Error("Invalid faucet limits");
    this.#ledger = ledger;
    this.#chain = chain;
    this.#options = options;
  }

  async fund(
    account: Address,
    amount: bigint,
  ): Promise<{ transactionHash: Hex; amount: string; account: Address }> {
    if (amount <= 0n || amount > this.#options.maxAmount) throw new FaucetRejected();
    const reservation = await this.#ledger.reserve(
      this.#options.chainId,
      account,
      amount,
      this.#options.dailyLimit,
    );
    const before = await this.#chain.balanceOf(account);
    try {
      const transactionHash = await this.#chain.transfer(account, amount);
      await this.#chain.awaitSuccess(transactionHash);
      const after = await this.#chain.balanceOf(account);
      if (after - before !== amount) throw new FaucetRejected();
      await this.#ledger.complete(reservation, transactionHash);
      return { transactionHash, amount: amount.toString(), account };
    } catch (error) {
      await this.#ledger.fail(
        reservation,
        error instanceof Error ? error.message.slice(0, 200) : "Faucet transfer failed",
      );
      if (error instanceof FaucetRejected) throw error;
      throw new FaucetRejected(
        error instanceof Error ? error.message || "Faucet transfer failed" : undefined,
        { cause: error },
      );
    }
  }
}

export class ViemFaucetChain implements FaucetChain {
  readonly #client;
  readonly #wallet;
  readonly #account: PrivateKeyAccount;
  readonly #chain: Chain;
  readonly #token: Address;

  constructor(options: {
    rpcUrl: string;
    chain: Chain;
    account: PrivateKeyAccount;
    token: Address;
  }) {
    this.#chain = options.chain;
    this.#account = options.account;
    this.#token = options.token;
    this.#client = createPublicClient({ chain: options.chain, transport: http(options.rpcUrl) });
    this.#wallet = createWalletClient({
      chain: options.chain,
      transport: http(options.rpcUrl),
      account: options.account,
    });
  }

  balanceOf(account: Address): Promise<bigint> {
    return this.#client.readContract({
      address: this.#token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>;
  }

  async transfer(account: Address, amount: bigint): Promise<Hex> {
    return this.#wallet.writeContract({
      address: this.#token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [account, amount],
      account: this.#account,
      chain: this.#chain,
    });
  }

  async awaitSuccess(hash: Hex): Promise<void> {
    const receipt = await this.#client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new FaucetRejected();
  }
}

/** Loads a 32-byte hex faucet key from a file. */
export async function loadFaucetAccount(path: string): Promise<PrivateKeyAccount> {
  const text = (await readFile(path, "utf8")).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error("Faucet private key file must contain a 32-byte hex key");
  return privateKeyToAccount(text as Hex);
}

export class PostgresFaucetLedger implements FaucetLedger {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async assertReady(): Promise<void> {
    await this.#pool.query("SELECT id FROM faucet_grants LIMIT 0");
  }

  async reserve(
    chainId: number,
    account: Address,
    amount: bigint,
    dailyLimit: bigint,
  ): Promise<string> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent grants so the daily cap cannot be exceeded by a race.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('openbalance-faucet'))");
      const total = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount::numeric), 0)::text AS total
           FROM faucet_grants
          WHERE chain_id = $1 AND status <> 'FAILED' AND created_at >= date_trunc('day', now())`,
        [chainId],
      );
      if (BigInt(total.rows[0]?.total ?? "0") + amount > dailyLimit) throw new FaucetExhausted();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO faucet_grants (chain_id, account, amount, status)
         VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
        [chainId, account.toLowerCase(), amount.toString()],
      );
      await client.query("COMMIT");
      const id = inserted.rows[0]?.id;
      if (!id) throw new FaucetRejected();
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(id: string, transactionHash: Hex): Promise<void> {
    await this.#pool.query(
      `UPDATE faucet_grants SET status='GRANTED', transaction_hash=$2, updated_at=now() WHERE id=$1`,
      [id, transactionHash.toLowerCase()],
    );
  }

  async fail(id: string, reason: string): Promise<void> {
    await this.#pool.query(
      `UPDATE faucet_grants SET status='FAILED', error=$2, updated_at=now() WHERE id=$1`,
      [id, reason],
    );
  }
}
