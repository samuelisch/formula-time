// Unit test: `dumpRecording` against an in-memory fake `DumpDb` — no
// Postgres. Pins the recording layout (session.json, one raw/<endpoint>.jsonl
// line per event, an empty polls.jsonl), the two refusal paths (unknown
// session key; an --out directory already carrying polls.jsonl), the
// zero-events case, and that paging by `seq` never drops or reorders rows.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { dumpRecording, sessionRawFromRow } from "./dump-recording.js";
import type { DumpDb, DumpEventRow, DumpSessionRow } from "./dump-recording.js";

function fakeDb(session: DumpSessionRow | null, events: DumpEventRow[]): DumpDb {
  return {
    session: {
      async findUnique() {
        return session;
      },
    },
    event: {
      async findMany(args) {
        const cursor = args.where.seq.gt;
        return events
          .filter((row) => row.seq > cursor)
          .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
          .slice(0, args.take);
      },
    },
  };
}

const SESSION_ROW: DumpSessionRow = {
  sessionKey: 11361n,
  name: "Race",
  country: "Italy",
  circuitKey: 39,
  circuitShortName: "Monza",
  location: "Monza",
  dateStart: new Date("2026-09-06T13:00:00.000Z"),
  dateEnd: new Date("2026-09-06T15:00:00.000Z"),
};

function eventRow(seq: number, endpoint: string, receivedAt: string, payload: unknown): DumpEventRow {
  return { seq: BigInt(seq), endpoint, receivedAt: new Date(receivedAt), payload };
}

async function readJsonl(filePath: string): Promise<Array<{ received_at: string; payload: unknown }>> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { received_at: string; payload: unknown });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dump-recording-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("sessionRawFromRow: translates the stored row into OpenF1 field names, omitting columns the table doesn't keep", () => {
  const raw = sessionRawFromRow(SESSION_ROW);
  expect(raw).toEqual({
    session_key: 11361,
    session_name: "Race",
    country_name: "Italy",
    circuit_key: 39,
    date_start: "2026-09-06T13:00:00.000Z",
    date_end: "2026-09-06T15:00:00.000Z",
    circuit_short_name: "Monza",
    location: "Monza",
  });
  expect(raw).not.toHaveProperty("meeting_key");
  expect(raw).not.toHaveProperty("session_type");
});

test("dumps session.json, one raw/<endpoint>.jsonl line per event in seq order, and an empty polls.jsonl", async () => {
  const outDir = path.join(dir, "out");
  const events = [
    eventRow(1, "drivers", "2026-09-06T12:57:30.000Z", { driver_number: 1 }),
    eventRow(2, "drivers", "2026-09-06T12:57:30.500Z", { driver_number: 2 }),
    eventRow(3, "position", "2026-09-06T13:00:01.000Z", { driver_number: 1, x: 1 }),
    eventRow(4, "position", "2026-09-06T13:00:02.000Z", { driver_number: 1, x: 2 }),
  ];
  const logs: string[] = [];

  const result = await dumpRecording(11361n, fakeDb(SESSION_ROW, events), outDir, {
    onLog: (line) => logs.push(line),
    now: () => Date.parse("2026-09-07T00:00:00.000Z"),
  });

  expect(result).toEqual({ found: true, events: 4, endpoints: ["drivers", "position"] });

  const sessionJson = JSON.parse(await readFile(path.join(outDir, "session.json"), "utf8")) as {
    session: unknown;
    discovered_at: string;
  };
  expect(sessionJson.session).toEqual(sessionRawFromRow(SESSION_ROW));
  expect(sessionJson.discovered_at).toBe("2026-09-07T00:00:00.000Z");

  const drivers = await readJsonl(path.join(outDir, "raw", "drivers.jsonl"));
  expect(drivers).toEqual([
    { received_at: "2026-09-06T12:57:30.000Z", payload: { driver_number: 1 } },
    { received_at: "2026-09-06T12:57:30.500Z", payload: { driver_number: 2 } },
  ]);

  const position = await readJsonl(path.join(outDir, "raw", "position.jsonl"));
  expect(position).toEqual([
    { received_at: "2026-09-06T13:00:01.000Z", payload: { driver_number: 1, x: 1 } },
    { received_at: "2026-09-06T13:00:02.000Z", payload: { driver_number: 1, x: 2 } },
  ]);

  const polls = await readFile(path.join(outDir, "polls.jsonl"), "utf8");
  expect(polls).toBe("");

  expect(logs.some((line) => line.includes("events=4"))).toBe(true);
});

test("paging: rows spanning more than one page still land in one file, in seq order, none dropped", async () => {
  const rowCount = 5001; // one row over the page size forces a second page
  const events: DumpEventRow[] = [];
  for (let i = 1; i <= rowCount; i += 1) {
    events.push(eventRow(i, "position", new Date(2026, 8, 6, 13, 0, 0, i).toISOString(), { i }));
  }

  const outDir = path.join(dir, "out");
  const result = await dumpRecording(11361n, fakeDb(SESSION_ROW, events), outDir, { onLog: () => {} });

  expect(result.events).toBe(rowCount);
  const position = await readJsonl(path.join(outDir, "raw", "position.jsonl"));
  expect(position).toHaveLength(rowCount);
  expect(position.map((row) => (row.payload as { i: number }).i)).toEqual(
    Array.from({ length: rowCount }, (_, index) => index + 1),
  );
});

test("an unknown session key is refused, logs once, and writes nothing", async () => {
  const outDir = path.join(dir, "out");
  const logs: string[] = [];

  const result = await dumpRecording(999n, fakeDb(null, []), outDir, { onLog: (line) => logs.push(line) });

  expect(result).toEqual({ found: false, events: 0, endpoints: [] });
  expect(logs).toEqual(["dump: refused 999: no session found"]);
  expect(existsSync(outDir)).toBe(false);
});

test("an --out directory already carrying polls.jsonl is refused unless --force, and writes nothing when refused", async () => {
  const outDir = path.join(dir, "real-recording");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "polls.jsonl"), '{"t":"x"}\n');
  const logs: string[] = [];

  const refused = await dumpRecording(11361n, fakeDb(SESSION_ROW, []), outDir, {
    onLog: (line) => logs.push(line),
  });
  expect(refused.found).toBe(false);
  expect(logs.some((line) => line.includes("already holds polls.jsonl"))).toBe(true);
  // The pre-existing polls.jsonl content is untouched, and no session.json was written.
  expect(await readFile(path.join(outDir, "polls.jsonl"), "utf8")).toBe('{"t":"x"}\n');
  expect(existsSync(path.join(outDir, "session.json"))).toBe(false);

  const forced = await dumpRecording(11361n, fakeDb(SESSION_ROW, []), outDir, { force: true, onLog: () => {} });
  expect(forced.found).toBe(true);
  expect(await readFile(path.join(outDir, "polls.jsonl"), "utf8")).toBe("");
});

test("re-dumping with --force into a directory already holding a prior dump's raw/<endpoint>.jsonl does not duplicate lines", async () => {
  const outDir = path.join(dir, "out");
  const events = [
    eventRow(1, "position", "2026-09-06T13:00:01.000Z", { driver_number: 1, x: 1 }),
    eventRow(2, "position", "2026-09-06T13:00:02.000Z", { driver_number: 1, x: 2 }),
  ];

  const first = await dumpRecording(11361n, fakeDb(SESSION_ROW, events), outDir, { onLog: () => {} });
  expect(first.events).toBe(2);
  expect(await readJsonl(path.join(outDir, "raw", "position.jsonl"))).toHaveLength(2);

  // A re-dump of the exact same session, forced over the existing output —
  // the retry-after-crash / re-run case the polls.jsonl guard exists to
  // allow. The file must end with exactly this dump's rows, not the sum of
  // both runs.
  const second = await dumpRecording(11361n, fakeDb(SESSION_ROW, events), outDir, {
    force: true,
    onLog: () => {},
  });
  expect(second.events).toBe(2);
  const position = await readJsonl(path.join(outDir, "raw", "position.jsonl"));
  expect(position).toHaveLength(2);
  expect(position).toEqual([
    { received_at: "2026-09-06T13:00:01.000Z", payload: { driver_number: 1, x: 1 } },
    { received_at: "2026-09-06T13:00:02.000Z", payload: { driver_number: 1, x: 2 } },
  ]);
});

test("a session with zero events writes session.json and empty files, and says so", async () => {
  const outDir = path.join(dir, "out");
  const logs: string[] = [];

  const result = await dumpRecording(11361n, fakeDb(SESSION_ROW, []), outDir, {
    onLog: (line) => logs.push(line),
  });

  expect(result).toEqual({ found: true, events: 0, endpoints: [] });
  expect(existsSync(path.join(outDir, "session.json"))).toBe(true);
  expect(await readFile(path.join(outDir, "polls.jsonl"), "utf8")).toBe("");
  expect(existsSync(path.join(outDir, "raw"))).toBe(true);
  expect(logs.some((line) => line.includes("has no events"))).toBe(true);
});
