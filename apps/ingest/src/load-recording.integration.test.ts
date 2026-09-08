// Integration test (issue #63 deliverable "Integration test"; ADR-0002):
// needs the real Postgres from the root `docker-compose.yml`. Pins the two
// facts only Postgres enforces: loading the same fixture recording twice
// leaves the row count unchanged (DB-level dedup via
// `event.createMany({ skipDuplicates: true })` on `event_id`, same as
// writer.integration.test.ts), and `sessions.status = finished`.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, expect, test } from "vitest";

import { createDb } from "@formula-time/db";

import { loadRecordings } from "./load-recording.js";
import type { RawRecord } from "./openf1/types.js";

const db = createDb(undefined, { max: 1 });

const SESSION_KEY = 9_000_004n;

const SESSION_JSON = {
  session: {
    session_key: Number(SESSION_KEY),
    session_type: "Race",
    session_name: "Race",
    date_start: "2026-01-01T13:00:00+00:00",
    date_end: "2026-01-01T15:00:00+00:00",
    meeting_key: 1,
    circuit_key: 39,
    country_name: "Italy",
  },
  discovered_at: "2026-01-01T12:57:00.000Z",
};

function jsonlLine(payload: RawRecord): string {
  return `${JSON.stringify({ received_at: "2026-01-01T13:00:01.000Z", payload })}\n`;
}

async function wipe(): Promise<void> {
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

let dir: string;

beforeEach(async () => {
  await wipe();
  dir = await mkdtemp(path.join(tmpdir(), "load-recording-it-"));
  await mkdir(path.join(dir, "raw"), { recursive: true });
  await writeFile(path.join(dir, "session.json"), JSON.stringify(SESSION_JSON));
  await writeFile(
    path.join(dir, "raw", "position.jsonl"),
    jsonlLine({ session_key: Number(SESSION_KEY), driver_number: 1, date: "2026-01-01T13:00:01Z", x: 1, y: 1 }) +
      jsonlLine({ session_key: Number(SESSION_KEY), driver_number: 1, date: "2026-01-01T13:00:02Z", x: 2, y: 2 }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

test("loading the same fixture twice: row count unchanged on the second run, session status finished", async () => {
  const first = await loadRecordings([dir], db, { onLog: () => {} });
  // 22 static entry-list drivers + 2 position rows.
  expect(first).toEqual({ inserted: 24, skipped: 0 });

  const countAfterFirst = await db.event.count({ where: { sessionKey: SESSION_KEY } });
  expect(countAfterFirst).toBe(24);

  const session = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });
  expect(session.status).toBe("finished");

  const second = await loadRecordings([dir], db, { onLog: () => {} });
  expect(second).toEqual({ inserted: 0, skipped: 24 });

  const countAfterSecond = await db.event.count({ where: { sessionKey: SESSION_KEY } });
  expect(countAfterSecond).toBe(24);
}, 30_000);
