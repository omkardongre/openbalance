// Resolves the real Foundry binaries and refuses to run against an impostor.
//
// `forge` is not a unique name: Atlassian's app-platform CLI publishes an npm package that installs
// a global `forge` shim, and a Node version manager's bin directory routinely precedes
// ~/.foundry/bin on PATH. A bare spawn("forge") then resolves to the wrong program, which does not
// fail loudly — it fails as an unrelated usage error partway through a deployment. Deployment
// tooling must not be able to make that mistake, so every binary is identified by its own
// --version banner before use and an unidentified binary is a hard failure.

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Foundry's banners are `forge Version: 1.8.1`, `cast Version: ...`, `anvil Version: ...`. The
// Atlassian CLI prints a bare semver with no tool name, so requiring the prefix separates them.
const BANNER = /^(forge|cast|anvil) Version:/;

const cache = new Map();

async function candidates(tool) {
  const found = [];
  const explicit = process.env.FOUNDRY_BIN;
  if (explicit) found.push(join(explicit, tool));
  found.push(join(homedir(), ".foundry", "bin", tool));
  for (const entry of (process.env.PATH ?? "").split(delimiter))
    if (entry) found.push(join(entry, tool));
  return found;
}

function version(binary) {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

/**
 * Absolute path to a verified Foundry binary. Throws if no candidate identifies itself as Foundry,
 * naming what was rejected so a shadowed PATH is obvious rather than mysterious.
 */
export async function foundryBin(tool) {
  if (!["forge", "cast", "anvil"].includes(tool)) throw new Error(`Unsupported binary: ${tool}`);
  const cached = cache.get(tool);
  if (cached) return cached;

  const rejected = [];
  for (const binary of await candidates(tool)) {
    try {
      await access(binary, constants.X_OK);
    } catch {
      continue;
    }
    const banner = await version(binary);
    if (banner && BANNER.test(banner)) {
      cache.set(tool, binary);
      return binary;
    }
    rejected.push(`${binary} (${banner ? banner.split("\n")[0] : "no version output"})`);
  }

  throw new Error(
    `No Foundry '${tool}' binary found. Install Foundry (https://getfoundry.sh) or set FOUNDRY_BIN.` +
      (rejected.length ? ` Rejected non-Foundry candidates: ${rejected.join(", ")}` : ""),
  );
}

/** Runs a verified Foundry binary, resolving trimmed stdout and rejecting on a non-zero exit. */
export async function foundry(tool, args, options = {}) {
  const binary = await foundryBin(tool);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      shell: false,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`${tool} ${args[0] ?? ""} failed: ${(stderr || stdout).slice(-600)}`)),
    );
  });
}
