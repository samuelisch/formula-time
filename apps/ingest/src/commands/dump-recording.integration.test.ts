// Integration test (ADR-0002): needs the real Postgres from the root
// `docker-compose.yml`, and the real recording at `recordings/11361` — the
// Italian GP capture, gitignored on purpose ("not repo content"), same
// `test.skipIf(!existsSync(dir))` shape as `load-recording.integration.
// test.ts`'s own 11361 fixture test.
//
// Pins the round-trip invariant (the decision this command exists for):
// `load-recording --replace` of a dumped recording reproduces the same
// `event_id` set, in the same `received_at` order per endpoint, as the
// session it was dumped from.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, test } from "vitest";

import { createDb } from "@formula-time/db";

import { dumpRecording } from "./dump-recording.js";
import { loadRecordings } from "./load-recording.js";
import { eventId } from "../openf1/normalize.js";

const db = createDb(undefined, { max: 1 });

const RECORDING_11361_DIR =
  process.env["RECORDING_11361_DIR"] ?? path.resolve(fileURLToPath(import.meta.url), "../../../../../recordings/11361");
const SESSION_KEY = 11361n;

async function wipeRecording11361(): Promise<void> {
  // `exports`/`polls`/`votes` (api's writer) FK to `sessions` — a prior
  // manual/local run of the stack against this same recording can leave
  // them behind; clear everything downstream before the session row itself.
  await db.vote.deleteMany({ where: { poll: { sessionKey: SESSION_KEY } } });
  await db.poll.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.export.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.event.deleteMany({ where: { sessionKey: SESSION_KEY } });
  await db.session.deleteMany({ where: { sessionKey: SESSION_KEY } });
}

afterAll(async () => {
  await wipeRecording11361();
  await db.$disconnect();
});

interface DbEventRow {
  eventId: string;
  endpoint: string;
  receivedAt: Date;
}

async function readAllDbEvents(): Promise<DbEventRow[]> {
  const rows: DbEventRow[] = [];
  let cursor = 0n;
  for (;;) {
    const page = await db.event.findMany({
      where: { sessionKey: SESSION_KEY, seq: { gt: cursor } },
      orderBy: { seq: "asc" },
      take: 5000,
      select: { seq: true, eventId: true, endpoint: true, receivedAt: true },
    });
    if (page.length === 0) break;
    for (const row of page) rows.push({ eventId: row.eventId, endpoint: row.endpoint, receivedAt: row.receivedAt });
    cursor = page[page.length - 1]!.seq;
    if (page.length < 5000) break;
  }
  return rows;
}

function groupByEndpoint<T extends { endpoint: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.endpoint) ?? [];
    group.push(row);
    groups.set(row.endpoint, group);
  }
  return groups;
}

async function readDumpedJsonl(
  filePath: string,
): Promise<Array<{ received_at: string; payload: Record<string, unknown> }>> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { received_at: string; payload: Record<string, unknown> });
}

test.skipIf(!existsSync(RECORDING_11361_DIR))(
  "load, dump, and load --replace the dump: same event_id set, same received_at order per endpoint",
  async () => {
    await wipeRecording11361();
    try {
      const loaded = await loadRecordings([RECORDING_11361_DIR], db, { onLog: () => {} });
      expect(loaded.sessionsAttempted).toBe(1);
      expect(loaded.sessionsSkipped).toBe(0);

      const originalRows = await readAllDbEvents();
      expect(originalRows.length).toBeGreaterThan(0);
      const originalEventIds = new Set(originalRows.map((row) => row.eventId));
      const originalByEndpoint = groupByEndpoint(originalRows);

      const dumpDir = await mkdtemp(path.join(tmpdir(), "dump-recording-it-"));
      try {
        const dumped = await dumpRecording(SESSION_KEY, db, dumpDir, { onLog: () => {} });
        expect(dumped.found).toBe(true);
        expect(dumped.events).toBe(originalRows.length);
        expect(new Set(dumped.endpoints)).toEqual(new Set(originalByEndpoint.keys()));

        // The set of event_ids the loader would produce from the dump equals
        // the set already in the database, and received_at order per
        // endpoint matches seq order — computed directly from the dumped
        // files, before any reload.
        const dumpedEventIds = new Set<string>();
        for (const [endpoint, originalGroup] of originalByEndpoint) {
          const dumpedRows = await readDumpedJsonl(path.join(dumpDir, "raw", `${endpoint}.jsonl`));
          expect(dumpedRows).toHaveLength(originalGroup.length);
          expect(dumpedRows.map((row) => row.received_at)).toEqual(
            originalGroup.map((row) => row.receivedAt.toISOString()),
          );
          for (const row of dumpedRows) dumpedEventIds.add(eventId(endpoint, row.payload));
        }
        expect(dumpedEventIds).toEqual(originalEventIds);

        // The invariant itself: reload the dump in place and confirm nothing
        // changed — same row count, same event_id set.
        const replaced = await loadRecordings([dumpDir], db, { onLog: () => {}, replace: true });
        expect(replaced.sessionsSkipped).toBe(0);

        const afterReplaceRows = await readAllDbEvents();
        expect(afterReplaceRows.length).toBe(originalRows.length);
        expect(new Set(afterReplaceRows.map((row) => row.eventId))).toEqual(originalEventIds);
      } finally {
        await rm(dumpDir, { recursive: true, force: true });
      }
    } finally {
      await wipeRecording11361();
    }
  },
  120_000,
);
