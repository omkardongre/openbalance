import { encodeOfflineVoucher, type OfflineVoucher } from "@openbalance/protocol";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { ViemVoucherSettlementGateway } from "../src/chain.js";
import type { VoucherReceipt } from "../src/journal.js";
import { PermanentSettlementFailure } from "../src/settlement.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const chain = defineChain({
  id: 10_143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.example.invalid"] } },
});

it("rejects receipts targeting a vault outside the configured deployment", async () => {
  const voucher: OfflineVoucher = {
    protocolVersion: 1,
    chainId: 10_143n,
    vault: "0x2222222222222222222222222222222222222222",
    channelId: hex32("3"),
    sequence: 1,
    previousVoucherDigest: hex32("4"),
    paymentId: hex32("5"),
    orderRefHash: hex32("6"),
    grossUnits: 100n,
    cumulativeGrossUnits: 100n,
    receiptCommitment: hex32("7"),
    acceptedAt: 100,
    acceptUntil: 200,
    submitUntil: 300,
    configVersion: 1n,
  };
  const receipt: VoucherReceipt = {
    receiptId: "receipt:wrong-vault",
    terminalId: hex32("8"),
    channelId: voucher.channelId,
    sequence: 1,
    paymentId: voucher.paymentId,
    voucher: encodeOfflineVoucher(voucher),
    attendeeSignature: `0x${"aa".repeat(65)}`,
    terminalSignature: `0x${"bb".repeat(65)}`,
  };
  const gateway = new ViemVoucherSettlementGateway({
    rpcUrl: "https://rpc.example.invalid",
    chain,
    account: privateKeyToAccount(hex32("1")),
    vault: "0x9999999999999999999999999999999999999999",
    deploymentBlock: 1n,
  });
  await expect(gateway.submit(receipt)).rejects.toThrow(PermanentSettlementFailure);
});

it("finds a settled voucher by reading only its window, in chunks a capped RPC accepts", async () => {
  const { createServer } = await import("node:http");
  const { encodeAbiParameters, keccak256, toHex, stringToHex } = await import("viem");
  const vault = "0x9999999999999999999999999999999999999999" as const;
  // One block per second from block 0 at t=1_000; finalized head far beyond the voucher window.
  const head = 50_000n;
  const time = (block: bigint) => 1_000n + block;
  const voucher: OfflineVoucher = {
    protocolVersion: 1,
    chainId: 10_143n,
    vault,
    channelId: hex32("3"),
    sequence: 1,
    previousVoucherDigest: hex32("4"),
    paymentId: hex32("5"),
    orderRefHash: hex32("6"),
    grossUnits: 100n,
    cumulativeGrossUnits: 100n,
    receiptCommitment: hex32("7"),
    acceptedAt: 20_000,
    acceptUntil: 22_000,
    submitUntil: 23_500,
    configVersion: 1n,
  };
  const settledAt = 21_900n;
  const topic0 = keccak256(
    stringToHex("VoucherSettled(bytes32,bytes32,uint32,uint256,uint256,bytes32)"),
  );
  const ranges: bigint[][] = [];
  const block = (number: bigint) => ({
    number: toHex(number),
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    parentHash: `0x${"00".repeat(32)}`,
    timestamp: toHex(time(number)),
    logsBloom: `0x${"00".repeat(256)}`,
    transactions: [],
    gasLimit: "0x1",
    gasUsed: "0x0",
    baseFeePerGas: "0x1",
    difficulty: "0x0",
    miner: `0x${"00".repeat(20)}`,
    extraData: "0x",
    size: "0x1",
    stateRoot: `0x${"00".repeat(32)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    nonce: "0x0000000000000000",
    mixHash: `0x${"00".repeat(32)}`,
    uncles: [],
  });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body);
      const reply = (result: unknown, error?: { code: number; message: string }) =>
        response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...(error ? { error } : { result }) }));
      if (call.method === "eth_chainId") return reply(toHex(10_143));
      if (call.method === "eth_getBlockByNumber") {
        const tag = call.params[0];
        return reply(block(tag === "finalized" || tag === "latest" ? head : BigInt(tag)));
      }
      if (call.method === "eth_getLogs") {
        const from = BigInt(call.params[0].fromBlock);
        const to = BigInt(call.params[0].toBlock);
        if (to - from >= 1_000n)
          return reply(null, { code: -32602, message: "eth_getLogs is limited to a 1,000 range" });
        ranges.push([from, to]);
        const block = settledAt - 1_000n;
        if (block < from || block > to) return reply([]);
        return reply([
          {
            address: vault,
            blockNumber: toHex(block),
            blockHash: `0x${block.toString(16).padStart(64, "0")}`,
            transactionHash: hex32("e"),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
            topics: [
              topic0,
              voucher.channelId,
              voucher.paymentId,
              `0x${"1".padStart(64, "0")}`,
            ],
            data: encodeAbiParameters(
              [{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
              [100n, 100n, hex32("f")],
            ),
          },
        ]);
      }
      return reply(null, { code: -32601, message: `unsupported ${call.method}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const gateway = new ViemVoucherSettlementGateway({
      rpcUrl: `http://127.0.0.1:${address.port}`,
      chain,
      account: privateKeyToAccount(hex32("1")),
      vault,
      deploymentBlock: 1n,
    });
    const receipt: VoucherReceipt = {
      receiptId: "receipt:settled",
      terminalId: hex32("8"),
      channelId: voucher.channelId,
      sequence: 1,
      paymentId: voucher.paymentId,
      voucher: encodeOfflineVoucher(voucher),
      attendeeSignature: `0x${"aa".repeat(65)}`,
      terminalSignature: `0x${"bb".repeat(65)}`,
    };
    await expect(gateway.reconcile(receipt, null)).resolves.toEqual({
      status: "SETTLED",
      transactionHash: hex32("e"),
    });
    // Only the acceptance-to-submission window is read, never history from the deployment block.
    expect(ranges[0]?.[0]).toBe(BigInt(voucher.acceptedAt) - 1_000n);
    expect(ranges.at(-1)?.[1]).toBe(BigInt(voucher.submitUntil) - 1_000n);
  } finally {
    server.close();
  }
});
