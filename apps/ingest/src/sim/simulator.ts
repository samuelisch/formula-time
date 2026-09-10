// Drip simulator: replays a live-recorder recording (or a real ingest
// recording under `LIVE_LOG_DIR`) as if the race were happening now. Lifted
// from `../f1-live-events-poc/poc/live-recorder/simulator.ts`:
// it impersonates the recorder — writing session.json and appending raw
// rows into a fresh directory at the pace they originally arrived
// (`received_at`), optionally time-compressed — so the unmodified ingest
// REST lane (via `LIVE_SOURCE=<out-root>`, `file-fetcher.ts` "root mode")
// experiences the recorded race as live.
//
//   race day: OpenF1 -> ingest (rest-lane + recorder) -> files -> ingest (LIVE_SOURCE) -> ...
//   sim:      recording -> simulator -> files -> ingest (LIVE_SOURCE) -> ...
//
// ADR-0001 rule this keeps: only ingest talks to OpenF1. The simulator
// reads a file and touches no network.

import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RawRecord } from "../openf1/types.js";

export interface SimRow {
  receivedAt: number;
  endpoint: string;
  line: string; // original JSONL line, re-emitted verbatim
}

export function shiftSessionWindow(session: RawRecord, deltaMs: number): RawRecord {
  const shifted: RawRecord = { ...session };
  for (const field of ["date_start", "date_end"]) {
    const value = session[field];
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isNaN(parsed)) shifted[field] = new Date(parsed + deltaMs).toISOString();
  }
  return shifted;
}

export function scheduleAt(row: SimRow, firstReceivedAt: number, wallStart: number, speed: number): number {
  return wallStart + (row.receivedAt - firstReceivedAt) / speed;
}

// Where the drip begins. "recording" (default) drips from the first recorded
// row. "race" bursts everything before (first laps-row arrival − leadMs) into
// the files INSTANTLY, then drips from there — the full log still exists
// (drivers seed, green-light anchor, early race_control), you just don't wait
// through the pre-race at 1x.
export function startCutMs(rows: SimRow[], start: string, leadMs = 60_000): number {
  const first = rows[0]?.receivedAt ?? 0;
  if (start !== "race") return first;
  const firstLap = rows.find((row) => row.endpoint === "laps");
  if (!firstLap) return first;
  return Math.max(first, firstLap.receivedAt - leadMs);
}

const RECORDED_ENDPOINTS = ["drivers", "position", "laps", "intervals", "pit", "race_control", "weather", "stints"];

export async function loadRecordingRows(recordingDir: string): Promise<SimRow[]> {
  const rows: SimRow[] = [];
  for (const endpoint of RECORDED_ENDPOINTS) {
    const filePath = path.join(recordingDir, "raw", `${endpoint}.jsonl`);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { received_at?: string };
        const receivedAt = Date.parse(parsed.received_at ?? "");
        if (Number.isNaN(receivedAt)) continue;
        rows.push({ receivedAt, endpoint, line });
      } catch {
        // skip a partially-written trailing line
      }
    }
  }
  // Stable by arrival time; ties keep per-endpoint file order (Array.sort is stable).
  rows.sort((left, right) => left.receivedAt - right.receivedAt);
  return rows;
}

export interface SimOptions {
  recordingDir: string;
  simKey: number;
  outRoot: string;
  speed: number;
  start: "recording" | "race";
  onLog?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the drip: burst-writes everything before the cut instantly, then
 * drips the rest on the recorded cadence divided by `speed`. Resolves once
 * every row has been written.
 */
export async function runSimulation(opts: SimOptions): Promise<void> {
  const log = opts.onLog ?? ((line: string) => console.log(line));
  const outDir = path.join(opts.outRoot, String(opts.simKey));

  const sessionFile = JSON.parse(await readFile(path.join(opts.recordingDir, "session.json"), "utf8")) as {
    session: RawRecord;
  };
  const rows = await loadRecordingRows(opts.recordingDir);
  if (rows.length === 0) throw new Error(`no rows found under ${opts.recordingDir}/raw`);

  // Safety: never wipe a real recording (real recordings carry polls.jsonl).
  try {
    await stat(path.join(outDir, "polls.jsonl"));
    throw new Error(`${outDir} looks like a real recording (has polls.jsonl); refusing to overwrite`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing")) throw error;
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "raw"), { recursive: true });

  // The drip origin: everything recorded before it is burst-written up front.
  const cutMs = startCutMs(rows, opts.start);
  const wallStart = Date.now();
  // Shift the session window so discovery sees it live now (the cut maps to
  // "now"). The window length is not scaled: at high speed the data just
  // finishes early inside it.
  const delta = wallStart - cutMs;
  // simulated: true lets the UI label this "SIM · <country>" instead of
  // masquerading as a real live race.
  const session = { ...shiftSessionWindow(sessionFile.session, delta), session_key: opts.simKey, simulated: true };
  await writeFile(
    path.join(outDir, "session.json"),
    JSON.stringify(
      { session, simulated_from: opts.recordingDir, speed: opts.speed, started_at: new Date(wallStart).toISOString() },
      null,
      2,
    ) + "\n",
  );

  const spanMs = rows.at(-1)!.receivedAt - cutMs;
  log(`drip simulator: ${rows.length} rows, dripping ${(spanMs / 60000).toFixed(1)} recorded minutes (--start ${opts.start})`);
  log(`  source: ${opts.recordingDir}  ->  ${outDir} (session_key=${opts.simKey})`);
  log(`  speed: ${opts.speed}x (finishes in ~${(spanMs / opts.speed / 60000).toFixed(1)} min). Ctrl+C to stop.`);

  let index = 0;
  let written = 0;

  // Burst-write the pre-cut history instantly (in order, grouped per file) so
  // the server has the complete log without waiting through the pre-race.
  if (cutMs > rows[0]!.receivedAt) {
    const byEndpoint = new Map<string, string[]>();
    while (index < rows.length && rows[index]!.receivedAt < cutMs) {
      const row = rows[index]!;
      const lines = byEndpoint.get(row.endpoint) ?? [];
      lines.push(row.line);
      byEndpoint.set(row.endpoint, lines);
      index += 1;
    }
    for (const [endpoint, lines] of byEndpoint) {
      await appendFile(path.join(outDir, "raw", `${endpoint}.jsonl`), lines.join("\n") + "\n");
      written += lines.length;
    }
    log(`  fast-forward: ${written} pre-race rows written instantly; dripping from the cut`);
  }
  let lastLog = Date.now();
  while (index < rows.length) {
    // Batch every row due by now (same received_at bursts flush together).
    const due = scheduleAt(rows[index]!, cutMs, wallStart, opts.speed);
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);

    const byEndpoint = new Map<string, string[]>();
    while (index < rows.length && scheduleAt(rows[index]!, cutMs, wallStart, opts.speed) <= Date.now()) {
      const row = rows[index]!;
      const lines = byEndpoint.get(row.endpoint) ?? [];
      lines.push(row.line);
      byEndpoint.set(row.endpoint, lines);
      index += 1;
    }
    for (const [endpoint, lines] of byEndpoint) {
      await appendFile(path.join(outDir, "raw", `${endpoint}.jsonl`), lines.join("\n") + "\n");
      written += lines.length;
    }
    if (Date.now() - lastLog >= 10_000) {
      const simElapsed = (rows[Math.min(index, rows.length - 1)]!.receivedAt - cutMs) / 60000;
      log(`  t+${simElapsed.toFixed(1)} recorded min · ${written}/${rows.length} rows dripped`);
      lastLog = Date.now();
    }
  }
  log(`done: ${written} rows dripped. The session window stays open for late viewers.`);
}
