// Replay smoke (issue Tests: "Replay smoke"). Needs the real Postgres from
// `docker-compose.yml` AND the POC's Italian GP recording, which lives
// outside this repo at the absolute path below (a worktree's `../` does not
// reach `../f1-live-events-poc`) — skipped, loudly, when that path isn't
// present (e.g. a reviewer's machine or CI without the POC checked out).
//
// Drives the REST lane's file fetcher (LIVE_SOURCE=<directory>) through the
// same normalizer, queue and writer production code uses, then asserts the
// two facts the issue names: the writer inserts (a large number of) events,
// and a second run of the exact same replay inserts zero more (DB-level
// dedup via `event.createMany({ skipDuplicates: true })` on `event_id`).

import { existsSync } from "node:fs";

import { afterAll, beforeAll, expect, test } from "vitest";

import { createDb } from "@formula-time/db";

import { createFileFetcher } from "./openf1/file-fetcher.js";
import { RestLane, POLL_ROTATION } from "./openf1/rest-lane.js";
import type { QueueItem, RawRecord } from "./openf1/types.js";
import { EventQueue } from "./writer/queue.js";
import { upsertSession } from "./writer/sessions.js";
import { EventWriter } from "./writer/writer.js";

const POC_DIR = "/Users/samuelchan/code/f1-live-events-poc/poc/live-logs/11361";
const SESSION_KEY = 11361n;
// Mid-race: session.json date_start=2026-09-06T13:00:00+00:00,
// date_end=2026-09-06T15:00:00+00:00. Pinning `now` here (rather than the
// wall clock) is what makes the smoke reproducible regardless of when it runs.
const NOW_MS = Date.parse("2026-09-06T14:00:00Z");

const db = createDb(undefined, { max: 1 });

async function wipe(): Promise<void> {
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

beforeAll(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

async function runOneReplayPass(): Promise<{ inserted: number; skipped: number }> {
  const fetcher = createFileFetcher(POC_DIR);
  const queue = new EventQueue<QueueItem>();
  const writer = new EventWriter(db, queue);
  const restLane = new RestLane(queue, {
    fetcher,
    now: () => NOW_MS,
    onSession: async (session: RawRecord, nowMs: number) => upsertSession(db, session, nowMs),
    onLog: () => {}, // quiet; this test already logs its own summary
  });

  await restLane.discoverOnce(); // selects the session, fetches drivers?session_key= once
  // One full rotation cycle guarantees every endpoint in POLL_ROTATION has
  // been polled (and, since the file fetcher returns the whole recorded
  // file per request, fully drained) at least once.
  for (let i = 0; i < POLL_ROTATION.length; i++) {
    await restLane.pollOnce();
  }

  return writer.drainAll();
}

test.skipIf(!existsSync(POC_DIR))(
  "replaying the Italian GP recording inserts a large number of events, zero duplicates on a second run",
  async () => {
    const first = await runOneReplayPass();
    console.log(`replay smoke: first pass inserted=${first.inserted} skipped=${first.skipped}`);
    // The recording (poc/live-logs/11361/raw/*.jsonl) holds ~28.4k already-
    // deduped rows (drivers + position + intervals + laps + pit +
    // race_control + stints + weather); 25,000 leaves margin without
    // pinning an exact count to a file this repo doesn't own.
    expect(first.inserted).toBeGreaterThan(25_000);
    expect(first.skipped).toBe(0);

    const countAfterFirst = await db.event.count({ where: { sessionKey: SESSION_KEY } });
    expect(countAfterFirst).toBe(first.inserted);

    const second = await runOneReplayPass();
    console.log(`replay smoke: second pass inserted=${second.inserted} skipped=${second.skipped}`);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(countAfterFirst);

    const countAfterSecond = await db.event.count({ where: { sessionKey: SESSION_KEY } });
    expect(countAfterSecond).toBe(countAfterFirst);
  },
  120_000,
);
