import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { trimRecording } from "./trim-recording.mjs";

const dirs: string[] = [];

// A scratch directory under the OS tmpdir, cleaned up after each test so a
// failing test never leaves fixtures behind for the next one to trip over.
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trim-recording-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

// Builds a minimal recording under `dir`: session.json, raw/drivers.jsonl
// (2 rows, both outside the trim window since drivers is kept in full
// regardless), raw/laps.jsonl (rows inside and outside an example window),
// and polls.jsonl (the POC recorder's log, which the script always drops).
function writeFixtureRecording(dir: string): void {
  writeFileSync(join(dir, "session.json"), JSON.stringify({ session: { session_key: 1 } }, null, 2) + "\n");
  writeFileSync(join(dir, "polls.jsonl"), '{"received_at":"2026-01-01T00:00:00.000Z","poll_id":"p1"}\n');
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(
    join(dir, "raw", "drivers.jsonl"),
    [
      '{"received_at":"2026-01-01T00:00:00.000Z","payload":{"driver_number":1}}',
      '{"received_at":"2026-01-01T00:05:00.000Z","payload":{"driver_number":2}}',
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "raw", "laps.jsonl"),
    [
      '{"received_at":"2026-01-01T00:00:59.000Z","payload":{"lap_number":0}}', // before the window
      '{"received_at":"2026-01-01T00:01:00.000Z","payload":{"lap_number":1}}', // window start, inclusive
      '{"received_at":"2026-01-01T00:02:00.000Z","payload":{"lap_number":2}}', // inside
      '{"received_at":"2026-01-01T00:03:00.000Z","payload":{"lap_number":3}}', // window end, inclusive
      '{"received_at":"2026-01-01T00:04:00.000Z","payload":{"lap_number":4}}', // after the window
      "not json at all", // malformed: not JSON
      '{"payload":{"lap_number":5}}', // malformed: no received_at
    ].join("\n") + "\n",
  );
}

const WINDOW = { from: "2026-01-01T00:01:00.000Z", to: "2026-01-01T00:03:00.000Z" };

describe("trimRecording", () => {
  it("keeps only the lines inside the window, in order, for a regular endpoint", () => {
    const inDir = scratchDir();
    const outDir = join(scratchDir(), "out");
    writeFixtureRecording(inDir);

    trimRecording(inDir, outDir, WINDOW);

    const kept = readFileSync(join(outDir, "raw", "laps.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(kept.map((r) => r.payload.lap_number)).toEqual([1, 2, 3]);
  });

  it("keeps drivers.jsonl in full regardless of the window", () => {
    const inDir = scratchDir();
    const outDir = join(scratchDir(), "out");
    writeFixtureRecording(inDir);

    trimRecording(inDir, outDir, WINDOW);

    const kept = readFileSync(join(outDir, "raw", "drivers.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(kept).toHaveLength(2);
  });

  it("copies session.json unchanged", () => {
    const inDir = scratchDir();
    const outDir = join(scratchDir(), "out");
    writeFixtureRecording(inDir);

    trimRecording(inDir, outDir, WINDOW);

    expect(readFileSync(join(outDir, "session.json"), "utf8")).toBe(readFileSync(join(inDir, "session.json"), "utf8"));
  });

  it("drops polls.jsonl", () => {
    const inDir = scratchDir();
    const outDir = join(scratchDir(), "out");
    writeFixtureRecording(inDir);

    trimRecording(inDir, outDir, WINDOW);

    expect(existsSync(join(outDir, "polls.jsonl"))).toBe(false);
  });

  it("drops a malformed line and counts it in the printed summary", () => {
    const inDir = scratchDir();
    const outDir = join(scratchDir(), "out");
    writeFixtureRecording(inDir);

    const summary = trimRecording(inDir, outDir, WINDOW);

    const laps = summary.find((s) => s.endpoint === "laps")!;
    // 7 lines total (5 well-formed + 2 malformed); 3 fall inside the window.
    expect(laps).toEqual({ endpoint: "laps", kept: 3, total: 7 });
  });

  it("refuses an existing out-dir without --force", () => {
    const inDir = scratchDir();
    const outDir = scratchDir(); // already exists
    writeFixtureRecording(inDir);

    expect(() => trimRecording(inDir, outDir, WINDOW)).toThrow(/out-dir already exists/);
  });

  it("overwrites an existing out-dir with force: true", () => {
    const inDir = scratchDir();
    const outDir = scratchDir();
    writeFileSync(join(outDir, "stale-file.txt"), "leftover from a previous run");
    writeFixtureRecording(inDir);

    trimRecording(inDir, outDir, { ...WINDOW, force: true });

    expect(existsSync(join(outDir, "stale-file.txt"))).toBe(false);
    expect(existsSync(join(outDir, "session.json"))).toBe(true);
  });
});
