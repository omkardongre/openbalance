#!/usr/bin/env node
// Runs the reserve-return CRE workflow on a schedule on this machine (systemd user timer).
//
//   install    Writes and starts `openbalance-reserve-return.{service,timer}`: one
//              `cre-reserve-return.mjs simulate` (cron trigger, --broadcast) every INTERVAL.
//   status     Shows the timer and the last runs' results.
//   uninstall  Stops and removes both units.
//
// Why here and not on Chainlink's DON: deploying needs CRE deploy access (an MNDA and commercial
// terms, per Chainlink's reply on 6 Oct 2026). Simulation is the supported hackathon path, and the
// CRE docs say a simulated cron trigger runs once per invocation, not on a schedule, so the schedule
// lives outside the CLI. Why not a cloud VM: `cre workflow simulate` needs a CRE login, and a
// headless API key (CRE_API_KEY) also requires deploy access. The browser login on this machine
// refreshes itself, so the timer runs here; copying that login to a VM is the user's call.
//
// Each run is idempotent: the workflow re-checks every candidate at the finalized block and the
// vault returns a reserve at most once, so an overlapping or repeated run can only find nothing to
// do. A run with nothing due sends no transaction and costs no gas. systemd never starts a second
// run while one is still going.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const unitDir = join(homedir(), ".config/systemd/user");
const NAME = "openbalance-reserve-return";
const INTERVAL = process.env.CRE_SCHEDULE_INTERVAL ?? "3min";

const systemctl = (...args) => {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed`);
};

function install() {
  if (!/^\d+(s|min|h)$/.test(INTERVAL))
    throw new Error("CRE_SCHEDULE_INTERVAL must look like 3min");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    join(unitDir, `${NAME}.service`),
    `[Unit]
Description=OpenBalance: return unspent outage reserves (Chainlink CRE workflow, simulation --broadcast)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart=${process.execPath} ${join(root, "scripts/cre-reserve-return.mjs")} simulate
# One run takes ~25 s; a stuck RPC must not hold the schedule.
TimeoutStartSec=5min
Nice=10
`,
  );
  writeFileSync(
    join(unitDir, `${NAME}.timer`),
    `[Unit]
Description=Run ${NAME} every ${INTERVAL}

[Timer]
OnBootSec=1min
OnUnitInactiveSec=${INTERVAL}
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
`,
  );
  systemctl("daemon-reload");
  systemctl("enable", "--now", `${NAME}.timer`);
  process.stdout.write(`Installed. Every ${INTERVAL}. Logs: journalctl --user -u ${NAME} -f\n`);
}

function status() {
  spawnSync("systemctl", ["--user", "list-timers", `${NAME}.timer`, "--no-pager"], {
    stdio: "inherit",
  });
  spawnSync(
    "journalctl",
    [
      "--user",
      "-u",
      NAME,
      "--no-pager",
      "-n",
      "200",
      "-o",
      "cat",
      "--grep",
      "Simulation Result|Returned|rror",
    ],
    { stdio: "inherit" },
  );
}

function uninstall() {
  spawnSync("systemctl", ["--user", "disable", "--now", `${NAME}.timer`], { stdio: "inherit" });
  rmSync(join(unitDir, `${NAME}.service`), { force: true });
  rmSync(join(unitDir, `${NAME}.timer`), { force: true });
  systemctl("daemon-reload");
  process.stdout.write("Removed.\n");
}

const commands = { install, status, uninstall };
const command = process.argv[2];
if (!commands[command]) {
  process.stderr.write(`Usage: cre-schedule.mjs ${Object.keys(commands).join(" | ")}\n`);
  process.exitCode = 64;
} else {
  try {
    commands[command]();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
