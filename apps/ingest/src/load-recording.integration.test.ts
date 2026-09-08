// Integration test (issue #63 deliverable "Integration test"; ADR-0002):
// needs the real Postgres from the root `docker-compose.yml`. Pins the two
// facts only Postgres enforces: loading the same fixture recording twice
// leaves the row count unchanged (DB-level dedup via
// `event.createMany({ skipDuplicates: true })` on `event_id`, same as
// writer.integration.test.ts), and `sessions.status = finished`.

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  expect(first).toEqual({ inserted: 24, skipped: 0, sessionsAttempted: 1, sessionsSkipped: 0 });

  const countAfterFirst = await db.event.count({ where: { sessionKey: SESSION_KEY } });
  expect(countAfterFirst).toBe(24);

  const session = await db.session.findUniqueOrThrow({ where: { sessionKey: SESSION_KEY } });
  expect(session.status).toBe("finished");

  const second = await loadRecordings([dir], db, { onLog: () => {} });
  expect(second).toEqual({ inserted: 0, skipped: 24, sessionsAttempted: 1, sessionsSkipped: 0 });

  const countAfterSecond = await db.event.count({ where: { sessionKey: SESSION_KEY } });
  expect(countAfterSecond).toBe(24);
}, 30_000);

// Issue #77: a bulk read of a complete recording used to emit every
// `position`/`intervals` row before any `laps` row (RECORDING_ENDPOINT_ORDER
// is a per-endpoint read order, not a time order), so `events.seq` for a
// loaded session was blocked by endpoint — the browser fold (seq order up to
// `source_time`) read that as "no lap yet" for most of a scrubbed replay.
// Real recording, not a fixture (`recordings/11361` — the Italian GP capture
// that surfaced the bug, psql-confirmed in the issue). `recordings/` is
// gitignored on purpose ("not repo content") — same shape as
// `replay.integration.test.ts`'s `REPLAY_RECORDING_DIR`: skipped, loudly,
// wherever the directory isn't present (CI, a reviewer's machine), and
// overridable by env var for a different layout.
const RECORDING_11361_DIR =
  process.env["RECORDING_11361_DIR"] ??
  path.resolve(fileURLToPath(import.meta.url), "../../../../recordings/11361");
const RECORDING_SESSION_KEY = 11361n;

async function wipeRecording11361(): Promise<void> {
  // `exports` (api's writer, ADR-0009) and `polls`/`votes` (api's writer)
  // both FK to `sessions` — a prior manual/local run of the stack against
  // this same recording can leave them behind; clear everything downstream
  // before the session row itself.
  await db.vote.deleteMany({ where: { poll: { sessionKey: RECORDING_SESSION_KEY } } });
  await db.poll.deleteMany({ where: { sessionKey: RECORDING_SESSION_KEY } });
  await db.export.deleteMany({ where: { sessionKey: RECORDING_SESSION_KEY } });
  await db.event.deleteMany({ where: { sessionKey: RECORDING_SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: RECORDING_SESSION_KEY } });
}

test.skipIf(!existsSync(RECORDING_11361_DIR))(
  "loading recordings/11361: the first laps row's seq is below the last position row's seq; a second load inserts no new rows",
  async () => {
    await wipeRecording11361();
    try {
      const first = await loadRecordings([RECORDING_11361_DIR], db, { onLog: () => {} });
      expect(first.sessionsAttempted).toBe(1);
      expect(first.sessionsSkipped).toBe(0);
      expect(first.inserted).toBeGreaterThan(0);

      const session = await db.session.findUniqueOrThrow({ where: { sessionKey: RECORDING_SESSION_KEY } });
      expect(session.status).toBe("finished");

      const firstLap = await db.event.findFirstOrThrow({
        where: { sessionKey: RECORDING_SESSION_KEY, endpoint: "laps" },
        orderBy: { seq: "asc" },
      });
      const lastPosition = await db.event.findFirstOrThrow({
        where: { sessionKey: RECORDING_SESSION_KEY, endpoint: "position" },
        orderBy: { seq: "desc" },
      });
      expect(firstLap.seq).toBeLessThan(lastPosition.seq);

      // Dedup: a second load of the same recording inserts nothing new.
      const second = await loadRecordings([RECORDING_11361_DIR], db, { onLog: () => {} });
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(first.inserted);
      const countAfterSecond = await db.event.count({ where: { sessionKey: RECORDING_SESSION_KEY } });
      expect(countAfterSecond).toBe(first.inserted);
    } finally {
      await wipeRecording11361();
    }
  },
  120_000,
);
