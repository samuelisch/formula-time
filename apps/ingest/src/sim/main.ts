// CLI entry for the drip simulator (issue #56). Run: `pnpm sim -- [flags]`
// (root) or `pnpm sim [flags]` inside `apps/ingest`. Flags match the POC's
// `poc/live-recorder/simulator.ts` exactly:
//   --recording <dir>   default ./live-logs/11361
//   --sim-key <n>        default 99911353
//   --out-root <dir>     default ./live-logs/sim
//   --speed <n>          default 1
//   --start recording|race   default recording

import { runSimulation } from "./simulator.js";

function valueFor(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const recordingDir = valueFor("--recording") ?? "./live-logs/11361";
  const simKey = Number(valueFor("--sim-key") ?? 99911353);
  const outRoot = valueFor("--out-root") ?? "./live-logs/sim";
  const speed = Number(valueFor("--speed") ?? 1);
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("--speed must be > 0");
  const start = valueFor("--start") ?? "recording";
  if (start !== "recording" && start !== "race") throw new Error("--start must be 'recording' or 'race'");

  await runSimulation({ recordingDir, simKey, outRoot, speed, start });
}

// Import-safe: only run as a script (a test could import main.ts without
// launching the drip).
if (process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js")) {
  await main();
}
