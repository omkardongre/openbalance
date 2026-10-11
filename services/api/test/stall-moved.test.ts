import { expect, it } from "vitest";
import { type MovedStallRow, movedStalls } from "../src/stall-onboarding.js";

const phone = "0x649a000000000000000000000000000000000dd0";
const row = (id: string, state: MovedStallRow["state"], seen: number | null, live = true) =>
  ({
    stall_id: id,
    state,
    terminal_signer: live ? phone : null,
    pending_terminal_signer: live ? null : phone,
    terminal_seen_at: seen === null ? null : new Date(seen),
  }) as MovedStallRow;

it("marks a live stall as moved once its phone checked in for another stall", () => {
  // Taco Stand went live first, then the same phone was set up for Fresh Juice.
  expect(movedStalls([row("taco", "LIVE", 1_000), row("juice", "LIVE", 2_000)])).toEqual(
    new Set(["taco"]),
  );
  // A phone that is only checked in (not yet approved) for the new stall already left the old one.
  expect(movedStalls([row("taco", "LIVE", 1_000), row("juice", "APPROVED", 2_000, false)])).toEqual(
    new Set(["taco"]),
  );
  // Scanning the old stall's code again moves the phone back.
  expect(movedStalls([row("taco", "LIVE", 3_000), row("juice", "LIVE", 2_000)])).toEqual(
    new Set(["juice"]),
  );
});

it("keeps stalls with their own phone, or with no check-in record, as they are", () => {
  const other = { ...row("juice", "LIVE", 2_000), terminal_signer: `0x${"1".repeat(40)}` };
  expect(movedStalls([row("taco", "LIVE", 1_000), other as MovedStallRow])).toEqual(new Set());
  expect(movedStalls([row("taco", "LIVE", null), row("juice", "LIVE", null)])).toEqual(new Set());
});
