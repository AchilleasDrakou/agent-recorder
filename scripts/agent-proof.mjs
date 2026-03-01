#!/usr/bin/env node
import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_SCRIPT = resolve(HERE, "agent-proof-live.mjs");

const REMOVED_OPTIONS = new Set([
  "--script",
  "--ws-endpoint",
]);

function hasOption(name) {
  return process.argv.slice(2).includes(name);
}

function printUsage() {
  console.log(`Usage:
  node scripts/agent-proof.mjs --url <url> --mode before|after --name <slug>
  node scripts/agent-proof.mjs --spec ./proof-spec.json

Core defaults:
  pace=cinematic, cursor-overlay=true

Notes:
  --script and --ws-endpoint were removed from the public CLI.
  Use action specs instead of custom page scripts.
`);
}

async function main() {
  if (hasOption("--help") || hasOption("-h")) {
    printUsage();
    return;
  }

  for (const removed of REMOVED_OPTIONS) {
    if (hasOption(removed)) {
      throw new Error(`${removed} is no longer supported in core mode`);
    }
  }

  const args = [LIVE_SCRIPT, ...process.argv.slice(2)];
  const child = spawn("node", args, { stdio: "inherit", env: process.env });
  await new Promise((resolveRun, rejectRun) => {
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`agent-proof-live exited with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

main().catch((err) => {
  console.error(`[agent-proof] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
