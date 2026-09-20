#!/usr/bin/env node
// Command-line entry to the verified Foundry resolution used by the deployment tooling, so package
// scripts cannot invoke a shadowed `forge`/`cast`/`anvil` from PATH.
//
// Usage: node scripts/foundry.mjs forge build --root contracts
//
// stdio is inherited so interactive output, colour and progress behave exactly as a direct call,
// and the child's exit code is propagated unchanged: a wrapper that swallowed a non-zero status
// would turn a failing build into a passing one.

import { spawn } from "node:child_process";
import { foundryBin } from "./foundry-bin.mjs";

const [tool, ...args] = process.argv.slice(2);
if (!tool) {
  process.stderr.write("Usage: foundry.mjs <forge|cast|anvil> [args...]\n");
  process.exit(2);
}

let binary;
try {
  binary = await foundryBin(tool);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(127);
}

const child = spawn(binary, args, { shell: false, stdio: "inherit", env: process.env });
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
