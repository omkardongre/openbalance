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
