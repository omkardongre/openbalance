import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VenueRelayJournal, type VoucherReceipt } from "../src/journal.js";
import {
  PermanentSettlementFailure,
  type VoucherSettlementGateway,
  VoucherSettlementProcessor,
} from "../src/settlement.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;
const bytes = (byte: string) => `0x${byte.repeat(130)}` as `0x${string}`;
const directories: string[] = [];

function receipt(sequence = 1): VoucherReceipt {
  return {
    receiptId: `receipt:${sequence}`,
    terminalId: hex32("1"),
    channelId: hex32("2"),
    sequence,
    paymentId: hex32(String(sequence)),
    voucher: bytes("3"),
    attendeeSignature: `0x${"4".repeat(130)}`,
    terminalSignature: `0x${"5".repeat(130)}`,
  };
}

function setup(gateway: VoucherSettlementGateway) {
  const directory = mkdtempSync(join(tmpdir(), "openbalance-settlement-"));
  directories.push(directory);
  const path = join(directory, "relay.sqlite");
  const key = randomBytes(32);
  const journal = new VenueRelayJournal(path, key);
  journal.ingest(receipt(), 100);
  const processor = new VoucherSettlementProcessor(journal, gateway, {
    owner: "settlement:1",
    pollMilliseconds: 1_000,
  });
  return { journal, processor, path, key };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("submits once and reconciles the finalized receipt after restart", async () => {
  const transactionHash = hex32("a");
  let reconciliationCount = 0;
  const reconcile = vi.fn(async () => {
    reconciliationCount += 1;
    return reconciliationCount === 1
      ? ({ status: "ABSENT" } as const)
      : ({ status: "SETTLED", transactionHash } as const);
  });
  const submit = vi.fn(async () => ({ transactionHash }));
  const gateway: VoucherSettlementGateway = { reconcile, submit };
  const { journal, processor, path, key } = setup(gateway);
  expect(await processor.runBatch(10, 200)).toEqual([
    { receiptId: "receipt:1", state: "SUBMITTED", transactionHash },
  ]);
  journal.close();

  const reopened = new VenueRelayJournal(path, key);
  const resumed = new VoucherSettlementProcessor(reopened, gateway, {
    owner: "settlement:2",
    pollMilliseconds: 1_000,
  });
  expect(await resumed.runBatch(10, 201)).toEqual([
    { receiptId: "receipt:1", state: "SETTLED", transactionHash },
  ]);
  expect(submit).toHaveBeenCalledOnce();
  reopened.close();
});

it("reconciles an uncertain commit before attempting another submission", async () => {
  const transactionHash = hex32("b");
  const gateway: VoucherSettlementGateway = {
    reconcile: vi.fn(async () => ({ status: "SETTLED" as const, transactionHash })),
    submit: vi.fn(async () => {
      throw new Error("must not submit");
    }),
  };
  const { journal, processor } = setup(gateway);
  expect((await processor.runBatch(1, 200))[0]?.state).toBe("SETTLED");
  expect(gateway.submit).not.toHaveBeenCalled();
  journal.close();
});

it("backs off transient failures and quarantines permanent failures", async () => {
  const transient: VoucherSettlementGateway = {
    reconcile: vi.fn(async () => {
      throw new Error("rpc unavailable");
    }),
    submit: vi.fn(),
  };
  const first = setup(transient);
  expect((await first.processor.runBatch(1, 200))[0]?.state).toBe("RETRY");
  expect(first.journal.leaseReady(1, "other", 2_199, 1_000)).toEqual([]);
  first.journal.close();

  const permanent: VoucherSettlementGateway = {
    reconcile: vi.fn(async () => ({ status: "ABSENT" as const })),
    submit: vi.fn(async () => {
      throw new PermanentSettlementFailure("invalid voucher");
    }),
  };
  const second = setup(permanent);
  expect((await second.processor.runBatch(1, 200))[0]?.state).toBe("QUARANTINED");
  second.journal.close();
});
