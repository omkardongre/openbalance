import { expect, it } from "vitest";
import { InvalidTerminalSnapshot, TerminalSnapshotDirectory } from "../src/directory.js";

const hex32 = (byte: string) => `0x${byte.repeat(64)}` as `0x${string}`;

function snapshot() {
  return {
    schemaVersion: 1,
    chainId: 10_143,
    registry: "0x1111111111111111111111111111111111111111",
    vault: "0x2222222222222222222222222222222222222222",
    finalizedBlockNumber: "100",
    finalizedBlockHash: hex32("3"),
    generatedAt: 100,
    expiresAt: 200,
    terminals: [
      {
        terminalId: hex32("4"),
        keyVersion: "1",
        channelId: hex32("5"),
        signer: "0x6666666666666666666666666666666666666666",
        enabled: true,
        validAfter: 90,
        validUntil: 180,
      },
    ],
  };
}

it("resolves only the exact terminal, version, and channel scope", async () => {
  const directory = new TerminalSnapshotDirectory(snapshot(), () => 150);
  await expect(
    directory.resolve({ terminalId: hex32("4"), keyVersion: 1n, channelId: hex32("5") }),
  ).resolves.toMatchObject({ enabled: true, validAfter: 90, validUntil: 180 });
  await expect(
    directory.resolve({ terminalId: hex32("4"), keyVersion: 2n, channelId: hex32("5") }),
  ).resolves.toBeNull();
});

it("fails closed for expired and duplicate snapshots", async () => {
  const expired = new TerminalSnapshotDirectory(snapshot(), () => 200);
  await expect(
    expired.resolve({ terminalId: hex32("4"), keyVersion: 1n, channelId: hex32("5") }),
  ).rejects.toThrow(InvalidTerminalSnapshot);
  const duplicate = snapshot();
  const [entry] = duplicate.terminals;
  if (!entry) throw new Error("fixture terminal is missing");
  duplicate.terminals.push({ ...entry });
  expect(() => new TerminalSnapshotDirectory(duplicate, () => 150)).toThrow(
    InvalidTerminalSnapshot,
  );
});
