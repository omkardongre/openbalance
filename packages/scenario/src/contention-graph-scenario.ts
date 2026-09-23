import { type Address, createWalletClient, type Hex, http } from "viem";
import {
  type ContentionEventContext,
  type ContentionScenarioOptions,
  type PreparedPayment,
  prepareContentionPayments,
  setupContentionEvent,
} from "./contention-scenario.js";

/**
 * Gas declared on the warm-up payment. Kept equal to the load harness's PAYMENT_GAS_LIMIT so the
 * one broadcast this scenario makes is funded on the same basis as the payments it measures.
 */
const WARMUP_GAS_LIMIT = 1_000_000n;

/** One payment's storage footprint, as extracted from a trace of it against the pinned pre-state. */
export type PaymentAccessSet = {
  label: string;
  paymentId: Hex;
  gasUsed: string;
  /** Every slot the payment read or wrote. */
  touched: { address: Address; slot: Hex }[];
  /** The subset it changed. */
  writes: { address: Address; slot: Hex }[];
  /**
   * Every slot the payment executed an `SSTORE` against, recovered from the opcode stream.
   *
   * Reported alongside `writes` because the two disagree, and the disagreement is the measurement.
   * `writes` comes from a value diff, so it omits a slot that was written back to the value it
   * already held — a same-value store, or a lock set and cleared within the call. Monad's optimistic
   * executor tracks accesses, not net value changes, so those stores do make a transaction conflict.
   * A value diff therefore understates contention, and only the opcode stream shows the write set
   * the scheduler actually sees.
   *
   * Slot keys only, without the owning address: the opcode stream carries a call depth rather than
   * an address, and every key that matters here is either a `keccak256`-derived mapping slot or a
   * low integer whose owner is unambiguous from the layout.
   */
  stores?: Hex[];
};

export type ContentionGraphResult = {
  schemaVersion: 1;
  kind: "payment-conflict-graph";
  environment: "local" | "testnet" | "mainnet";
  chainId: number;
  contractCodeHash: Hex;
  ledger: Address;
  router: Address;
  token: Address;
  /** Every payment was traced against this one block, so they share a single pre-state. */
  baseBlockNumber: string;
  paymentGasEstimate: string;
  transactions: PaymentAccessSet[];
};

type PrestateAccount = { storage?: Record<string, string> };
type PrestateDiff = {
  pre?: Record<string, PrestateAccount>;
  post?: Record<string, PrestateAccount>;
};
type CallTrace = { gasUsed?: string; error?: string; revertReason?: string; output?: string };
type StructLogTrace = {
  structLogs?: { op?: string; depth?: number; stack?: string[] }[];
};

/**
 * Extracts the storage footprint of `payerCount` independent payments and returns it unaggregated.
 *
 * Nothing is broadcast. Monad's execution is optimistic: a transaction is re-executed when an input
 * it read differs from an output an earlier transaction wrote, so the parallelism a contract can
 * receive is decided entirely by which storage slots its transactions touch. That is a static
 * property of a set of payments against a common pre-state, and simulating them recovers it exactly
 * — no offered load, no saturation, and no MON beyond creating and funding the payer accounts.
 *
 * Every payment is traced against one pinned block, which is the state a scheduler would hand to all
 * of them if it started them together. Attribution belongs to `scripts/contention-graph.mjs`.
 */
export type ContentionGraphOptions = Omit<ContentionScenarioOptions, "payerCounts"> & {
  /** How many independent payments to trace against the same pre-state. */
  payerCount: number;
};

export async function runContentionGraphScenario(
  options: ContentionGraphOptions,
): Promise<ContentionGraphResult> {
  const { payerCount } = options;
  if (!Number.isInteger(payerCount) || payerCount < 2 || payerCount > 500)
    throw new Error("Conflict graph payer count must be an integer between 2 and 500");

  const context = await setupContentionEvent(options);
  const { publicClient } = context.preparation;

  // One real payment is settled before the measured set is traced.
  //
  // This is not warm-up in the caching sense; it is the difference between measuring an event's
  // first sale and measuring its steady state. Beneficiary destinations are bound on first write
  // and are immutable thereafter, so against a pre-state where they are still unset every traced
  // payment necessarily writes them and appears to conflict on them. A live event binds them once
  // and then never touches them again, and that is the state the contention number is about.
  await settleWarmupPayment(context);

  const { prepared, paymentGasEstimate } = await prepareContentionPayments(
    { ...context.preparation, payerCount, label: `${context.run}:graph` },
    // Nothing is broadcast, so no sponsor needs MON. On Monad, where the declared gas limit is
    // charged in full, that float is the largest per-payer cost and skipping it is most of the
    // reason this measurement is affordable at widths a load test could never reach.
    { fundSponsors: false },
  );

  // Pinned after setup so that the accounts and balances the payments depend on already exist, and
  // pinned by number rather than "latest" so every payment is traced against identical state.
  // Every payment is a call into its own smart account, so a block pinned before those accounts
  // are visible would degrade each payment into a plain send to an address with no code: it
  // succeeds, touches nothing, and would be recorded as a payment with an empty storage footprint.
  //
  // Waiting is necessary rather than defensive. Monad executes blocks asynchronously from consensus,
  // so `eth_blockNumber` can report a height whose state does not yet include transactions that
  // have already been accepted — the setup receipts are not sufficient evidence that the state a
  // trace will read contains them.
  const baseBlockNumber = await pinExecutedBlock(publicClient, prepared);
  const block = `0x${baseBlockNumber.toString(16)}`;

  const trace = async <T>(
    payment: (typeof prepared)[number],
    config: Record<string, unknown>,
  ): Promise<T> =>
    (await publicClient.request({
      method: "debug_traceCall",
      params: [
        { from: payment.sponsor.address, to: payment.to, data: payment.data },
        block,
        {
          ...config,
          // Sponsors are deliberately unfunded here, and without a balance a node may refuse the
          // call before executing it. The override costs nothing and never reaches the chain.
          stateOverrides: { [payment.sponsor.address]: { balance: "0xde0b6b3a7640000" } },
        },
      ],
    } as never)) as T;

  const transactions: PaymentAccessSet[] = [];
  for (const [index, payment] of prepared.entries()) {
    const diff = await trace<PrestateDiff>(payment, {
      tracer: "prestateTracer",
      tracerConfig: { diffMode: true },
    });
    const call = await trace<CallTrace>(payment, { tracer: "callTracer" });
    // `prestateTracer` without diffMode is not a reliable read set: implementations differ on
    // whether they report untouched slots at all. An access list is specified to enumerate every
    // slot the execution touches, which is exactly the read-or-write set a conflict needs.
    const access = (await publicClient.request({
      method: "eth_createAccessList",
      params: [{ from: payment.sponsor.address, to: payment.to, data: payment.data }, block],
    } as never)) as { accessList?: { address: string; storageKeys?: string[] }[] };

    // `post` in diff mode carries only what changed, which is the net write set.
    const writes = slots(diff.post);
    const touched = (access.accessList ?? []).flatMap((entry) =>
      (entry.storageKeys ?? []).map((slot) => ({
        address: entry.address.toLowerCase() as Address,
        slot: pad(slot),
      })),
    );
    if (writes.length === 0)
      throw new Error(
        `Payment ${index} wrote no storage, so it did not settle; a reverted or short-circuited ` +
          "payment carries no information about contention. Traced " +
          `${touched.length} touched slot(s) using ${call.gasUsed ?? "no"} gas` +
          `${call.error ? `, error ${call.error}` : ""}` +
          `${call.revertReason ? `, reverted with ${call.revertReason}` : ""}`,
      );
    const gasUsed = BigInt(call.gasUsed ?? "0x0");
    if (gasUsed === 0n) throw new Error(`Payment ${index} reported no gas used`);

    // Only for the first payment. The opcode stream is orders of magnitude larger than either
    // summary tracer, and every payment in the set runs the same code path, so one is evidence.
    const stores = index === 0 ? await storeSlots(trace, payment) : undefined;

    transactions.push({
      label: `payment:${index}`,
      paymentId: payment.paymentId,
      gasUsed: gasUsed.toString(),
      touched,
      writes,
      ...(stores ? { stores } : {}),
    });
  }

  return {
    schemaVersion: 1,
    kind: "payment-conflict-graph",
    environment: context.environment,
    chainId: context.chainId,
    contractCodeHash: context.contractCodeHash,
    ledger: context.ledger,
    router: context.router,
    token: context.token,
    baseBlockNumber: baseBlockNumber.toString(),
    paymentGasEstimate: paymentGasEstimate.toString(),
    transactions,
  };
}

/**
 * Returns the distinct slot keys the payment executed an `SSTORE` against, in first-store order.
 *
 * `SSTORE` takes its key from the top of the stack. Node implementations report `structLogs` stacks
 * bottom-first, so the key is the last entry, and it is read from the log for the `SSTORE` itself
 * rather than the one after it because the operation pops its operands.
 */
async function storeSlots(
  trace: <T>(payment: PreparedPayment, config: Record<string, unknown>) => Promise<T>,
  payment: PreparedPayment,
): Promise<Hex[] | undefined> {
  const structured = await trace<StructLogTrace>(payment, {
    disableMemory: true,
    disableReturnData: true,
    disableStorage: true,
  });
  const logs = structured.structLogs ?? [];
  // Absent rather than fatal. The opcode stream is the heaviest trace a node can produce and hosted
  // RPC providers commonly disable the struct logger while still serving `callTracer` and
  // `prestateTracer`. Gas and the conflict graph do not depend on it, so a provider that withholds
  // it costs this run its `stores` field and nothing else; the field is documented as optional and
  // the local run supplies it.
  if (logs.length === 0) return undefined;
  const seen = new Set<Hex>();
  const ordered: Hex[] = [];
  for (const log of logs) {
    if (log.op !== "SSTORE") continue;
    const key = log.stack?.at(-1);
    if (!key) throw new Error("An SSTORE log carried no stack, so its slot key is unrecoverable");
    const slot = pad(key);
    if (seen.has(slot)) continue;
    seen.add(slot);
    ordered.push(slot);
  }
  return ordered;
}

/**
 * Settles a single payment so the event's one-time bindings are already in place.
 *
 * Broadcast rather than simulated, because a simulated payment leaves no state behind and the whole
 * point is to move the pre-state the measured payments are traced against.
 */
async function settleWarmupPayment(context: ContentionEventContext): Promise<void> {
  const { publicClient, chain, rpcUrl } = context.preparation;
  const { prepared, fees } = await prepareContentionPayments(
    { ...context.preparation, payerCount: 1, label: `${context.run}:warm` },
    { fundSponsors: true },
  );
  const payment = prepared[0];
  if (!payment) throw new Error("Warm-up payment was not prepared");
  const wallet = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account: payment.sponsor,
  });
  const hash = await wallet.sendTransaction({
    account: payment.sponsor,
    chain,
    to: payment.to,
    data: payment.data,
    gas: WARMUP_GAS_LIMIT,
    ...fees,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (receipt.status !== "success")
    throw new Error(
      "The warm-up payment reverted, so the event's one-time bindings are not in place and the " +
        "measured payments would each be traced as a first sale",
    );
}

/**
 * Returns a block height at which every payer account is already deployed.
 *
 * Confirmed at the pinned height itself, not merely at `latest`, because the height is what every
 * subsequent trace is addressed to and the two can disagree while execution is catching up.
 */
async function pinExecutedBlock(
  publicClient: ContentionEventContext["preparation"]["publicClient"],
  prepared: { to: Address }[],
): Promise<bigint> {
  const addresses = [...new Set(prepared.map((payment) => payment.to))];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 });
    const codes = await Promise.all(
      addresses.map((address) => publicClient.getCode({ address, blockNumber })),
    );
    if (codes.every((code) => code && code !== "0x")) return blockNumber;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Payer accounts were still not visible in executed state after waiting; cannot pin a block ` +
      "whose pre-state contains the accounts the payments call into",
  );
}

function slots(accounts: Record<string, PrestateAccount> | undefined) {
  const out: { address: Address; slot: Hex }[] = [];
  for (const [address, account] of Object.entries(accounts ?? {}))
    for (const slot of Object.keys(account?.storage ?? {}))
      out.push({ address: address.toLowerCase() as Address, slot: pad(slot) });
  return out;
}

/** Tracers may abbreviate a slot key, so widen it before it becomes a graph identity. */
function pad(slot: string): Hex {
  const body = slot.replace(/^0x/, "").toLowerCase();
  if (body.length > 64 || !/^[0-9a-f]*$/.test(body)) throw new Error(`Unusable slot key ${slot}`);
  return `0x${body.padStart(64, "0")}`;
}
