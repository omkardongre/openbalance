import { accountAbi, accountFactoryAbi, encodePaymentIntent } from "@openbalance/protocol";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseAbi,
  stringToHex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveChainFor } from "./account-scenario.js";
import { loadArtifact } from "./artifacts.js";
import { VirtualAuthenticator } from "./authenticator.js";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const registryReads = parseAbi([
  "function destinationDigest(bytes32 vendorId,uint256 version,address destination,uint256 deadline) view returns (bytes32)",
]);
const routerReads = parseAbi([
  "function intentDigest((uint32 schemaVersion,uint256 chainId,address router,bytes32 eventId,bytes32 paymentId,address payerAccount,bytes32 orderRefHash,bytes32 vendorId,uint256 vendorDestinationVersion,bytes32 terminalInstanceId,address asset,uint256 grossUnits,uint16 organizerFeeBps,uint16 platformFeeBps,uint256 configVersion,bytes32 receiptCommitment,uint48 validAfter,uint48 expiresAt,uint256 terminalKeyVersion) intent) view returns (bytes32)",
]);

const PAY = keccak256(stringToHex("PAY"));
const b32 = (label: string) => keccak256(stringToHex(label));

/**
 * The gas limit declared on every payment transaction.
 *
 * Fixed rather than estimated for two independent reasons. Monad charges the declared limit rather
 * than the amount used (§2 decision 4), so an estimate that drifts between tiers changes the cost
 * of the workload and how many transactions a block can hold — both of which would confound the
 * comparison this scenario exists to produce. And a per-transaction `eth_estimateGas` round trip
 * would put the burst's own pacing at the mercy of RPC latency.
 *
 * The value is checked against a real `eth_estimateGas` on the target chain once per tier, so it is
 * a fixed limit that has been shown to be sufficient rather than a guess. It needs the headroom it
 * has: a payment nests four calls deep (sponsor to smart account, to implementation, to router, to
 * ledger), and EIP-150 withholds a sixty-fourth of the remaining gas at each of them, so the
 * deepest frame sees appreciably less than the declared limit.
 */
const PAYMENT_GAS_LIMIT = 1_000_000n;
/**
 * Setup limits, kept separate from each other because a single generous value would be charged in
 * full on every one of them. Account creation deploys a clone and writes initial ownership; the
 * other two are an ERC-20 transfer and a bare value send.
 */
const CREATE_ACCOUNT_GAS_LIMIT = 500_000n;
const TRANSFER_GAS_LIMIT = 100_000n;
const VALUE_SEND_GAS_LIMIT = 30_000n;

export type ContentionScenarioOptions = {
  rpcUrl: string;
  deployerPrivateKey: Hex;
  /** Offered-load tiers, strictly increasing. Each tier is one burst of that many payers. */
  payerCounts: number[];
  /** Settlement asset units per payment; identical everywhere so gross is never a variable. */
  grossUnits?: bigint;
  rpId?: string;
  origin?: string;
  environment?: "local" | "testnet" | "mainnet";
};

export type ContentionObservation = {
  paymentId: Hex;
  status: "FINALIZED" | "REVERTED" | "REJECTED" | "PENDING";
  offeredAtMs: number;
  finalizedAtMs?: number;
  transactionHash?: Hex;
  blockHash?: Hex;
  blockNumber?: string;
  gasUsed?: string;
  effectiveGasPriceWei?: string;
};

/** One tier, shaped so it validates as a standalone contention run. */
export type ContentionTier = {
  schemaVersion: 1;
  environment: "local" | "testnet" | "mainnet";
  chainId: number;
  contractCodeHash: Hex;
  payerCount: number;
  /** What one payment actually needs on this chain, measured before the burst opened. */
  paymentGasEstimate: string;
  startedAtMs: number;
  endedAtMs: number;
  payments: ContentionObservation[];
  blocks: { blockNumber: string; gasUsed: string; gasLimit: string }[];
  /**
   * Native MON returned from the tier's sponsor keys after the measured window closed. Recorded so
   * the true cost of a run is auditable rather than inferred, and so a silent recovery failure
   * shows up as a number instead of as a mysteriously shrinking deployer balance.
   */
  sponsorResidue: { sweptWei: string; sweptCount: number; failedCount: number };
};

export type ContentionScenarioResult = {
  schemaVersion: 1;
  environment: "local" | "testnet" | "mainnet";
  chainId: number;
  contractCodeHash: Hex;
  ledger: Address;
  router: Address;
  paymentGasLimit: string;
  serialExecutionChain: boolean;
  tiers: ContentionTier[];
};

/**
 * Offers a rising series of concurrent payment bursts against one deployed event and reports where
 * every payment landed.
 *
 * Within a burst, each payer is a distinct smart account holding its own funds and authorising with
 * its own passkey, and each transaction is relayed by its own sponsor key. That isolation is the
 * point: anything still shared between these payments is shared because the *contracts* share it,
 * not because the workload does. Transactions are signed before the burst opens and broadcast as
 * raw payloads, so neither signing cost nor RPC nonce assignment enters the measured window.
 *
 * All tiers reuse one event, and therefore one ledger, one organizer fee slot and one platform fee
 * slot. Redeploying per tier would change the ledger's address, which its `immutable` registry and
 * asset bindings place inside its runtime bytecode — so the code hash that is supposed to identify
 * the logic under measurement would differ between tiers of the same series.
 *
 * The result is deliberately raw. Attribution belongs to `scripts/contention-metrics.mjs`, which
 * needs the block gas ceilings recorded here to separate a contention-bound run from a gas-bound
 * one, and needs the series to find where the mined rate stops tracking the offered rate.
 */
export async function runContentionScenario(
  options: ContentionScenarioOptions,
): Promise<ContentionScenarioResult> {
  const tiers = options.payerCounts;
  if (
    !Array.isArray(tiers) ||
    tiers.length === 0 ||
    tiers.some((value) => !Number.isInteger(value) || value < 2 || value > 500) ||
    tiers.some((value, index) => index > 0 && value <= (tiers[index - 1] as number))
  )
    throw new Error("Contention tiers must be strictly increasing integers between 2 and 500");

  const context = await setupContentionEvent(options);

  const completed: ContentionTier[] = [];
  for (const payerCount of tiers) {
    completed.push(
      await runTier({
        ...context.preparation,
        payerCount,
        // Distinct per tier so payment IDs and account salts never collide across bursts.
        label: `${context.run}:t${payerCount}`,
        environment: context.environment,
        contractCodeHash: context.contractCodeHash,
      }),
    );
  }

  return {
    schemaVersion: 1,
    environment: context.environment,
    chainId: context.chainId,
    contractCodeHash: context.contractCodeHash,
    ledger: context.ledger,
    router: context.router,
    paymentGasLimit: PAYMENT_GAS_LIMIT.toString(),
    serialExecutionChain: context.serialExecutionChain,
    tiers: completed,
  };
}

/**
 * Deploys one event and everything a payment needs to reach it, and pins the ledger's code hash.
 *
 * Shared by both contention scenarios so that a load run and a conflict-graph run exercise the same
 * deployment path. All payer counts reuse one event, and therefore one ledger, one organizer fee
 * slot and one platform fee slot: redeploying per tier would change the ledger's address, which its
 * `immutable` registry and asset bindings place inside its runtime bytecode — so the code hash meant
 * to identify the logic under measurement would differ between tiers of the same series.
 */
export type ContentionEventContext = {
  run: string;
  environment: "local" | "testnet" | "mainnet";
  chainId: number;
  serialExecutionChain: boolean;
  contractCodeHash: Hex;
  ledger: Address;
  router: Address;
  registry: Address;
  token: Address;
  preparation: Omit<PaymentPreparation, "payerCount" | "label">;
};

export async function setupContentionEvent(
  options: Omit<ContentionScenarioOptions, "payerCounts">,
): Promise<ContentionEventContext> {
  const rpId = options.rpId ?? "localhost";
  const origin = options.origin ?? "http://localhost:3000";
  const grossUnits = options.grossUnits ?? 1_000_000n;
  const chain = await resolveChainFor(options.rpcUrl);
  const deployer = privateKeyToAccount(options.deployerPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const wallet = createWalletClient({ chain, transport: http(options.rpcUrl), account: deployer });
  // Anvil executes serially, so nothing here carries a parallelism signal on it. Recorded rather
  // than rejected, because running the harness locally is how the harness itself is verified.
  const serialExecutionChain = chain.id === 31_337;
  const environment = options.environment ?? (serialExecutionChain ? "local" : "testnet");

  const run = `contention:${Date.now()}`;
  const vendorAuthority = privateKeyToAccount(b32(`${run}:vendor`));
  const terminalSigner = privateKeyToAccount(b32(`${run}:terminal`));
  const eventId = b32(`${run}:event`);

  const { token, registry, ledger, router } = await deployEvent({
    publicClient,
    wallet,
    chain,
    deployer,
    eventId,
  });
  const factory = await deployContract(publicClient, wallet, chain, deployer, "AccountFactory", []);
  const now = Number((await publicClient.getBlock()).timestamp);
  const { vendorId, terminalId } = await configureEvent({
    publicClient,
    wallet,
    chain,
    deployer,
    registry,
    run,
    now,
    vendorAuthority,
    terminalSigner,
  });

  const code = await publicClient.getCode({ address: ledger });
  if (!code) throw new Error("Settlement ledger has no deployed code to bind the measurement to");
  // Binds every number produced here to the exact bytecode that produced it, which is what makes a
  // before/after comparison a measurement rather than an assertion.
  const contractCodeHash = keccak256(code);

  return {
    run,
    environment,
    chainId: chain.id,
    serialExecutionChain,
    contractCodeHash,
    ledger,
    router,
    registry,
    token,
    preparation: {
      publicClient,
      wallet,
      chain,
      deployer,
      rpcUrl: options.rpcUrl,
      rpId,
      origin,
      factory,
      token,
      router,
      eventId,
      vendorId,
      terminalId,
      terminalSigner,
      grossUnits,
      validAfter: now,
      expiresAt: now + 86_400,
      chainId: chain.id,
    } satisfies Omit<PaymentPreparation, "payerCount" | "label">,
  };
}

export type PaymentPreparation = {
  publicClient: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  deployer: Account;
  rpcUrl: string;
  rpId: string;
  origin: string;
  factory: Address;
  token: Address;
  router: Address;
  eventId: Hex;
  vendorId: Hex;
  terminalId: Hex;
  terminalSigner: ReturnType<typeof privateKeyToAccount>;
  grossUnits: bigint;
  payerCount: number;
  label: string;
  validAfter: number;
  expiresAt: number;
  chainId: number;
};

export type PreparedPayment = {
  sponsor: ReturnType<typeof privateKeyToAccount>;
  paymentId: Hex;
  to: Address;
  data: Hex;
};

/**
 * Builds `payerCount` fully authorised payments without broadcasting any of them.
 *
 * Each payer is a distinct smart account holding its own funds and authorising with its own passkey,
 * relayed by its own sponsor key. That isolation is the point: anything still shared between these
 * payments is shared because the *contracts* share it, not because the workload does.
 *
 * `fundSponsors` is false for the callers that only simulate. Monad charges the declared gas limit,
 * so the MON handed to a sponsor is the single largest cost per payer, and a caller that never
 * broadcasts should not pay it.
 */
export async function prepareContentionPayments(
  input: PaymentPreparation,
  options: { fundSponsors: boolean },
): Promise<{
  prepared: PreparedPayment[];
  fees: Awaited<ReturnType<typeof feeFields>>;
  paymentGasEstimate: bigint;
}> {
  const { publicClient, wallet, chain, deployer, origin, grossUnits, label } = input;

  const payers = Array.from({ length: input.payerCount }, (_, index) => {
    const passkey = VirtualAuthenticator.create({ rpId: input.rpId, origin });
    const recovery = privateKeyToAccount(b32(`${label}:recovery:${index}`));
    return {
      index,
      passkey,
      salt: b32(`${label}:salt:${index}`),
      // One sponsor per payer so sender-nonce ordering cannot serialise the burst.
      sponsor: privateKeyToAccount(b32(`${label}:sponsor:${index}`)),
      ownership: {
        primary: passkey.publicKey,
        backup: { x: `0x${"00".repeat(32)}` as Hex, y: `0x${"00".repeat(32)}` as Hex },
        recovery: recovery.address,
      },
      account: undefined as Address | undefined,
    };
  });
  for (const payer of payers) {
    payer.account = (await publicClient.readContract({
      address: input.factory,
      abi: accountFactoryAbi,
      functionName: "predict",
      args: [payer.ownership, payer.passkey.rpIdHash, origin, payer.salt],
    })) as Address;
  }

  const fees = await feeFields(publicClient);
  const price = bidPrice(fees);
  await batch(publicClient, wallet, chain, deployer, fees, [
    ...payers.map((payer) => ({
      to: input.factory,
      data: encodeFunctionData({
        abi: accountFactoryAbi,
        functionName: "create",
        args: [payer.ownership, payer.passkey.rpIdHash, origin, payer.salt],
      }),
      gas: CREATE_ACCOUNT_GAS_LIMIT,
    })),
    ...payers.map((payer) => ({
      to: input.token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [payer.account as Address, grossUnits * 2n],
      }),
      gas: TRANSFER_GAS_LIMIT,
    })),
    ...(options.fundSponsors
      ? payers.map((payer) => ({
          to: payer.sponsor.address,
          // The bid for one declared-limit payment plus its sweep. Sized at the bid rather than the
          // expected charge because Reserve Balance budgets inflight gas at the bid price, so a
          // sponsor holding less has its payment excluded at consensus instead of executed. The
          // difference between bid and effective price is recovered by the sweep, not avoided here.
          value: sponsorFloatWei(price),
          gas: VALUE_SEND_GAS_LIMIT,
        }))
      : []),
  ]);

  // A funded sponsor cannot broadcast immediately.
  //
  // Monad reaches consensus on a block before executing it, so the balance consensus budgets a
  // sender's gas against comes from the execution state k blocks back. A sponsor funded moments ago
  // still reads as empty from that view, and its payment is rejected for insufficient balance even
  // though the funding receipt has already confirmed. Waiting for the credit to appear in executed
  // state and then letting k more blocks pass is what makes the sponsor spendable.
  //
  // This is not a latency concern for the measurement: it happens during preparation, before the
  // measured window opens, and the payments are signed afterwards.
  if (options.fundSponsors) {
    const expected = sponsorFloatWei(price);
    await waitForFundedBalances(
      publicClient,
      payers.map((payer) => payer.sponsor.address),
      expected,
    );
    await waitBlocks(publicClient, 5);
  }

  const prepared: PreparedPayment[] = [];
  for (const payer of payers) {
    const intent = {
      schemaVersion: 1,
      chainId: BigInt(input.chainId),
      router: input.router,
      eventId: input.eventId,
      paymentId: b32(`${label}:payment:${payer.index}`),
      payerAccount: payer.account as Address,
      orderRefHash: b32(`${label}:order:${payer.index}`),
      vendorId: input.vendorId,
      vendorDestinationVersion: 1n,
      terminalInstanceId: input.terminalId,
      asset: input.token,
      grossUnits,
      organizerFeeBps: 200,
      platformFeeBps: 100,
      configVersion: 1n,
      receiptCommitment: b32(`${label}:receipt:${payer.index}`),
      validAfter: input.validAfter,
      expiresAt: input.expiresAt,
      terminalKeyVersion: 1n,
    };
    const digest = (await publicClient.readContract({
      address: input.router,
      abi: routerReads,
      functionName: "intentDigest",
      args: [intent],
    })) as Hex;
    const deadline = BigInt(input.expiresAt);
    const commandDigest = (await publicClient.readContract({
      address: payer.account as Address,
      abi: accountAbi,
      functionName: "commandDigest",
      args: [
        PAY,
        keccak256(
          encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [input.router, digest]),
        ),
        deadline,
      ],
    })) as Hex;
    const assertion = payer.passkey.assert(commandDigest);
    prepared.push({
      sponsor: payer.sponsor,
      paymentId: intent.paymentId,
      to: payer.account as Address,
      data: encodeFunctionData({
        abi: accountAbi,
        functionName: "pay",
        args: [
          input.router,
          encodePaymentIntent(intent),
          await input.terminalSigner.sign({ hash: digest }),
          deadline,
          false,
          {
            r: assertion.r,
            s: assertion.s,
            challengeIndex: assertion.challengeIndex,
            typeIndex: assertion.typeIndex,
            authenticatorData: assertion.authenticatorData,
            clientDataJSON: assertion.clientDataJSON,
          },
        ],
      }),
    });
  }

  // One estimate per tier, before the measured window opens, on the first payer's fully authorised
  // payment. It is not used as the declared limit — that stays fixed, for the reasons above — it is
  // used to prove the fixed limit covers this chain's costs. Without it a limit that is too low
  // mines every payment as a revert, and a revert writes none of the slots under measurement, so
  // the run would report flawless parallelism while having measured nothing.
  const first = prepared[0];
  if (!first) throw new Error("Contention tier prepared no payment");
  const paymentGasEstimate = await publicClient.estimateGas({
    account: first.sponsor.address,
    to: first.to,
    data: first.data,
  });
  if (paymentGasEstimate > PAYMENT_GAS_LIMIT)
    throw new Error(
      `A payment needs ${paymentGasEstimate} gas on chain ${input.chainId} but the scenario ` +
        `declares ${PAYMENT_GAS_LIMIT}; raise PAYMENT_GAS_LIMIT and re-fund, because every ` +
        "payment would otherwise revert and measure nothing",
    );

  return { prepared, fees, paymentGasEstimate };
}

async function runTier(
  input: PaymentPreparation & {
    environment: "local" | "testnet" | "mainnet";
    contractCodeHash: Hex;
  },
): Promise<ContentionTier> {
  const { publicClient, chain } = input;
  const { prepared, fees, paymentGasEstimate } = await prepareContentionPayments(input, {
    fundSponsors: true,
  });

  const signed: { paymentId: Hex; raw: Hex }[] = [];
  for (const { sponsor, paymentId, to, data } of prepared) {
    const sponsorWallet = createWalletClient({
      chain,
      transport: http(input.rpcUrl),
      account: sponsor,
    });
    signed.push({
      paymentId,
      raw: await sponsorWallet.signTransaction({
        account: sponsor,
        chain,
        to,
        data,
        gas: PAYMENT_GAS_LIMIT,
        // Each sponsor is funded but otherwise untouched, so its first and only send is nonce 0.
        nonce: 0,
        ...fees,
      }),
    });
  }

  const startedAtMs = Date.now();
  const offered = await Promise.all(
    signed.map(async ({ paymentId, raw }) => {
      const offeredAtMs = Date.now();
      try {
        return {
          paymentId,
          offeredAtMs,
          hash: await publicClient.sendRawTransaction({ serializedTransaction: raw }),
        };
      } catch {
        return { paymentId, offeredAtMs, hash: undefined };
      }
    }),
  );
  const payments: ContentionObservation[] = await Promise.all(
    offered.map(async ({ paymentId, offeredAtMs, hash }) => {
      if (!hash) return { paymentId, status: "REJECTED" as const, offeredAtMs };
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
        return {
          paymentId,
          status: receipt.status === "success" ? ("FINALIZED" as const) : ("REVERTED" as const),
          offeredAtMs,
          finalizedAtMs: Date.now(),
          transactionHash: receipt.transactionHash,
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
        };
      } catch {
        return { paymentId, status: "PENDING" as const, offeredAtMs };
      }
    }),
  );
  const endedAtMs = Date.now();

  const blockNumbers = [
    ...new Set(payments.flatMap((payment) => (payment.blockNumber ? [payment.blockNumber] : []))),
  ];
  const blocks = await Promise.all(
    blockNumbers.map(async (blockNumber) => {
      const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
      return {
        blockNumber,
        gasUsed: block.gasUsed.toString(),
        gasLimit: block.gasLimit.toString(),
      };
    }),
  );

  // Every observation is on hand before a single MON moves back, so recovery cannot corrupt or fail
  // the evidence. The sweep runs outside the measured window, after `endedAtMs`.
  //
  // A sponsor holds far less than the 10 MON reserve, so its sweep ends below the reserve and is
  // admitted only under the emptying-transaction exception, which requires no other transaction
  // from that sender within the last k blocks. The payment was that transaction, so the sweep must
  // wait k blocks out. k is 3; waiting 5 costs nothing and keeps the margin honest.
  await waitBlocks(publicClient, 5);
  const sponsorResidue = await sweepSponsors({
    publicClient,
    chain,
    rpcUrl: input.rpcUrl,
    recipient: input.deployer.address,
    sponsors: prepared.map((payment) => payment.sponsor),
  });

  return {
    schemaVersion: 1,
    environment: input.environment,
    chainId: input.chainId,
    contractCodeHash: input.contractCodeHash,
    payerCount: input.payerCount,
    paymentGasEstimate: paymentGasEstimate.toString(),
    startedAtMs,
    endedAtMs,
    payments,
    blocks,
    sponsorResidue,
  };
}

/**
 * Waits until every address shows at least `expected` wei in executed state.
 *
 * A funding receipt is not sufficient evidence that the credit is visible: under asynchronous
 * execution a receipt can be available while the state a later check reads has not caught up. Polled
 * at `latest` with caching defeated, because a cached height would answer from before the credit.
 */
async function waitForFundedBalances(
  publicClient: PublicClient,
  addresses: Address[],
  expected: bigint,
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const balances = await Promise.all(
      addresses.map((address) => publicClient.getBalance({ address })),
    );
    if (balances.every((balance) => balance >= expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Sponsor funding of ${expected} wei was not visible in executed state for all ` +
      `${addresses.length} sponsor(s); their payments would be rejected for insufficient balance`,
  );
}

/** Waits for the chain to advance `count` blocks, so a reserve-balance window can close. */
async function waitBlocks(publicClient: PublicClient, count: number): Promise<void> {
  const start = await publicClient.getBlockNumber();
  const target = start + BigInt(count);
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if ((await publicClient.getBlockNumber()) >= target) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chain did not advance ${count} blocks from ${start}`);
}

/**
 * The multiplier applied to the observed base fee to derive `maxFeePerGas`.
 *
 * Deliberately modest, because on Monad this cap is not merely a safety bound on what a payment
 * pays — it sets what a sponsor must be *funded* with. Reserve Balance admits a transaction only
 * when the sender's balance covers `gas_price * gas_limit` at the bid price, so a sponsor holding
 * less than the full bid has its payment excluded at consensus rather than executed and charged.
 * Every gwei of unused headroom in the cap is therefore MON that must be sent to a throwaway key.
 *
 * Two is enough headroom. Monad's base fee has a floor of 100 MON-gwei and a controller that rises
 * slowly and falls quickly, so the gap between signing and inclusion cannot plausibly double it.
 *
 * @see https://docs.monad.xyz/developer-essentials/reserve-balance
 * @see https://docs.monad.xyz/developer-essentials/gas-on-monad
 */
const BASE_FEE_MULTIPLIER = 2n;
const PRIORITY_FEE_WEI = 1_000_000_000n;
/** Gas limit for the residue sweep: a bare value send, charged in full as Monad charges the limit. */
const SWEEP_GAS_LIMIT = 21_000n;

async function feeFields(publicClient: PublicClient) {
  const block = await publicClient.getBlock();
  if (block.baseFeePerGas == null) return { gasPrice: await publicClient.getGasPrice() };
  return {
    maxPriorityFeePerGas: PRIORITY_FEE_WEI,
    maxFeePerGas: block.baseFeePerGas * BASE_FEE_MULTIPLIER + PRIORITY_FEE_WEI,
  };
}

/** The bid price a transaction is funded against: the cap, since that is what consensus budgets. */
function bidPrice(fees: Awaited<ReturnType<typeof feeFields>>): bigint {
  return "gasPrice" in fees && fees.gasPrice ? fees.gasPrice : (fees.maxFeePerGas as bigint);
}

/**
 * What one payer costs the deployer in native MON, at the given bid price.
 *
 * Exported so a caller can refuse to open a run it cannot afford. A partially funded run is the
 * worst outcome available: Monad charges the declared limit on every setup transaction that did
 * land, so an abort halfway through a tier spends nearly as much as completing it and produces no
 * evidence at all.
 */
export function estimatePayerCostWei(bidPriceWei: bigint): bigint {
  return (
    (CREATE_ACCOUNT_GAS_LIMIT + TRANSFER_GAS_LIMIT + VALUE_SEND_GAS_LIMIT) * bidPriceWei +
    sponsorFloatWei(bidPriceWei)
  );
}

/**
 * What a sponsor must hold for its single payment to be admitted.
 *
 * The full bid, not the expected charge: Reserve Balance budgets inflight gas at the bid price, so
 * funding a sponsor at the effective price would have its payment excluded at consensus. The tenth
 * on top absorbs the sweep that returns the remainder.
 */
function sponsorFloatWei(bidPriceWei: bigint): bigint {
  return ((PAYMENT_GAS_LIMIT + SWEEP_GAS_LIMIT) * bidPriceWei * 11n) / 10n;
}

/**
 * Returns each sponsor's unspent float to the deployer once its payment has been mined.
 *
 * Without this, the difference between the bid a sponsor is funded against and the effective price
 * its payment is charged stays stranded in a throwaway key forever — across as many keys as the
 * widest tier, which is the dominant cost of a run and is pure loss rather than measurement.
 *
 * Best effort by construction. A sweep that fails leaves dust behind and must not fail a run whose
 * evidence is already collected, so every error here is swallowed and reported as a total.
 */
async function sweepSponsors(input: {
  publicClient: PublicClient;
  chain: Chain;
  rpcUrl: string;
  recipient: Address;
  sponsors: ReturnType<typeof privateKeyToAccount>[];
}): Promise<{ sweptWei: string; sweptCount: number; failedCount: number }> {
  const { publicClient, chain, rpcUrl, recipient, sponsors } = input;
  const fees = await feeFields(publicClient);
  const price = bidPrice(fees);
  // Monad charges the declared limit, so the fee withheld from a sweep is exactly this product.
  const feeWei = SWEEP_GAS_LIMIT * price;

  const results = await Promise.all(
    sponsors.map(async (sponsor) => {
      try {
        const balance = await publicClient.getBalance({ address: sponsor.address });
        // Below the fee the sweep is self-defeating; at the fee it nets nothing.
        if (balance <= feeWei) return { swept: 0n, ok: true };
        const value = balance - feeWei;
        const wallet = createWalletClient({
          chain,
          transport: http(rpcUrl),
          account: sponsor,
        });
        const hash = await wallet.sendTransaction({
          account: sponsor,
          chain,
          to: recipient,
          value,
          gas: SWEEP_GAS_LIMIT,
          ...fees,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
        return receipt.status === "success"
          ? { swept: value, ok: true }
          : { swept: 0n, ok: false };
      } catch {
        return { swept: 0n, ok: false };
      }
    }),
  );

  return {
    sweptWei: results.reduce((total, result) => total + result.swept, 0n).toString(),
    sweptCount: results.filter((result) => result.ok && result.swept > 0n).length,
    failedCount: results.filter((result) => !result.ok).length,
  };
}

async function deployContract(
  publicClient: PublicClient,
  wallet: WalletClient,
  chain: Chain,
  deployer: Account,
  name: string,
  args: readonly unknown[],
): Promise<Address> {
  const artifact = loadArtifact(`${name}.sol`, name);
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account: deployer,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress)
    throw new Error(`${name} deployment failed`);
  return receipt.contractAddress;
}

async function deployEvent(input: {
  publicClient: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  deployer: Account;
  eventId: Hex;
}) {
  const { publicClient, wallet, chain, deployer, eventId } = input;
  const token = await deployContract(publicClient, wallet, chain, deployer, "LocalTestToken", [
    deployer.address,
    1_000_000_000_000_000n,
  ]);
  const eventFactory = await deployContract(
    publicClient,
    wallet,
    chain,
    deployer,
    "EventFactory",
    [],
  );
  const artifact = loadArtifact("EventFactory.sol", "EventFactory");
  const hash = await wallet.writeContract({
    address: eventFactory,
    abi: artifact.abi,
    functionName: "deployEvent",
    args: [eventId, token, deployer.address, 1_000],
    account: deployer,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Event deployment reverted");
  const deployment = (await publicClient.readContract({
    address: eventFactory,
    abi: artifact.abi,
    functionName: "getDeployment",
    args: [deployer.address, eventId],
  })) as { registry: Address; ledger: Address; router: Address; vault: Address };
  return { token, ...deployment };
}

async function configureEvent(input: {
  publicClient: PublicClient;
  wallet: WalletClient;
  chain: Chain;
  deployer: Account;
  registry: Address;
  run: string;
  now: number;
  vendorAuthority: ReturnType<typeof privateKeyToAccount>;
  terminalSigner: ReturnType<typeof privateKeyToAccount>;
}) {
  const { publicClient, wallet, chain, deployer, registry, run, now } = input;
  const abi = loadArtifact("EventRegistry.sol", "EventRegistry").abi;
  const vendorId = b32(`${run}:vendor`);
  const terminalId = b32(`${run}:terminal`);
  const deadline = BigInt(now + 172_800);
  const send = async (functionName: string, args: readonly unknown[]) => {
    const hash = await wallet.writeContract({
      address: registry,
      abi,
      functionName,
      args,
      account: deployer,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  };
  await send("registerConfig", [
    1n,
    {
      validAfter: now,
      validUntil: now + 172_800,
      organizerFeeBps: 200,
      platformFeeBps: 100,
      maximumAcceptanceDuration: 3_600,
      maximumSubmissionDelay: 3_600,
      organizerDestination: deployer.address,
      platformDestination: deployer.address,
      termsHash: b32(`${run}:terms`),
      enabled: true,
    },
  ]);
  await send("registerVendor", [vendorId, input.vendorAuthority.address]);
  const destinationDigest = (await publicClient.readContract({
    address: registry,
    abi: registryReads,
    functionName: "destinationDigest",
    args: [vendorId, 1n, deployer.address, deadline],
  })) as Hex;
  await send("registerDestination", [
    vendorId,
    1n,
    deployer.address,
    deadline,
    await input.vendorAuthority.sign({ hash: destinationDigest }),
  ]);
  await send("registerTerminal", [
    terminalId,
    1n,
    vendorId,
    input.terminalSigner.address,
    now,
    now + 172_800,
  ]);
  return { vendorId, terminalId };
}

/** Sends setup calls with explicit sequential nonces so setup latency stays off the measured path. */
async function batch(
  publicClient: PublicClient,
  wallet: WalletClient,
  chain: Chain,
  deployer: Account,
  fees: Awaited<ReturnType<typeof feeFields>>,
  calls: { to: Address; data?: Hex; value?: bigint; gas: bigint }[],
): Promise<void> {
  let nonce = await publicClient.getTransactionCount({ address: deployer.address });
  const hashes: Hex[] = [];
  for (const call of calls) {
    hashes.push(
      await wallet.sendTransaction({
        account: deployer,
        chain,
        to: call.to,
        ...(call.data ? { data: call.data } : {}),
        ...(call.value ? { value: call.value } : {}),
        gas: call.gas,
        nonce: nonce++,
        ...fees,
      }),
    );
  }
  for (const [index, hash] of hashes.entries()) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (receipt.status === "success") continue;
    // Identify the call rather than reporting that one of them failed. These are sent in one batch
    // with declared limits, and the usual cause is a limit that is sufficient on a local chain and
    // short on a public one — which is invisible unless the failure names the call and its limit.
    const call = calls[index];
    throw new Error(
      `Contention scenario setup call ${index + 1}/${calls.length} reverted: to ${call?.to}, ` +
        `declared gas ${call?.gas}, used ${receipt.gasUsed}, tx ${hash}`,
    );
  }
}
