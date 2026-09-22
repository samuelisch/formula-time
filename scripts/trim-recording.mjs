#!/usr/bin/env node
// Trims a full recorded race session down to a time window, for a small
// e2e fixture that can be committed to git. session.json is copied
// unchanged; raw/drivers.jsonl is kept in full, since the board's first
// fold needs every driver regardless of when the window starts; every
// other raw/<endpoint>.jsonl keeps only the rows whose received_at falls
// in [from, to] (inclusive), in their original order; polls.jsonl (the
// POC recorder's own HTTP poll log, unused by the app) and any other file
// raw/ does not define are dropped.
// Usage: node scripts/trim-recording.mjs <in-dir> <out-dir> --from <ISO> --to <ISO> [--force]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * @param {string[]} argv
 * @returns {{ inDir?: string, outDir?: string, from?: string, to?: string, force: boolean }}
 */
export function parseArgs(argv) {
  const positional = [];
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from") args.from = argv[++i];
    else if (arg === "--to") args.to = argv[++i];
    else if (arg === "--force") args.force = true;
    else positional.push(arg);
  }
  args.inDir = positional[0];
  args.outDir = positional[1];
  return args;
}

/**
 * Filters one endpoint's lines down to the window, in order. A line that
 * fails to parse as JSON or carries no `received_at` string is dropped and
 * counted only in `total`, never `kept`.
 * @param {string[]} lines non-empty lines from one raw/<endpoint>.jsonl
 * @param {{ keepAll: boolean, from: string, to: string }} opts
 * @returns {{ kept: string[], total: number }}
 */
export function trimLines(lines, { keepAll, from, to }) {
  const kept = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.received_at !== "string") continue;
    if (keepAll || (row.received_at >= from && row.received_at <= to)) kept.push(line);
  }
  return { kept, total: lines.length };
}

/**
 * @param {string} inDir a full recording directory (session.json, raw/*.jsonl, polls.jsonl)
 * @param {string} outDir the fixture directory to write; refused if it already exists unless force
 * @param {{ from: string, to: string, force?: boolean }} opts
 * @returns {{ endpoint: string, kept: number, total: number }[]} one entry per raw/<endpoint>.jsonl, in the order written
 */
export function trimRecording(inDir, outDir, { from, to, force = false }) {
  if (existsSync(outDir)) {
    if (!force) throw new Error(`out-dir already exists: ${outDir} (use --force)`);
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(join(outDir, "raw"), { recursive: true });

  copyFileSync(join(inDir, "session.json"), join(outDir, "session.json"));

  const rawDir = join(inDir, "raw");
  const files = readdirSync(rawDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const summary = [];
  for (const file of files) {
    const endpoint = basename(file, ".jsonl");
    const lines = readFileSync(join(rawDir, file), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const { kept, total } = trimLines(lines, { keepAll: endpoint === "drivers", from, to });
    writeFileSync(join(outDir, "raw", file), kept.length ? kept.join("\n") + "\n" : "");
    summary.push({ endpoint, kept: kept.length, total });
  }
  return summary;
}

function main() {
  const { inDir, outDir, from, to, force } = parseArgs(process.argv.slice(2));
  if (!inDir || !outDir || !from || !to) {
    console.error("usage: node scripts/trim-recording.mjs <in-dir> <out-dir> --from <ISO> --to <ISO> [--force]");
    process.exit(2);
  }
  try {
    const summary = trimRecording(inDir, outDir, { from, to, force });
    for (const { endpoint, kept, total } of summary) {
      console.log(`${endpoint}: kept ${kept} of ${total}`);
    }
  } catch (err) {
    console.error(`trim-recording: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
