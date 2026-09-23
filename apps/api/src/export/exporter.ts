// The exporter (ADR-0009): sole writer of the `exports` table. A finished
// session with at least one non-`drivers` event and no `exports` row is
// exported once, atomically; one with only `drivers` events is skipped and
// re-checked later; an already-exported session is re-exported once
// `events` gains a row after its `exported_at`. Runs its own 5s tick,
// non-overlapping. See README: Exports.
import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { PrismaClient, Session } from "@formula-time/db";
import type { RaceEvent, RaceFile, RawRecord } from "@formula-time/domain";

export type ExporterLog = (msg: string, fields?: Record<string, unknown>) => void;

export interface ExporterOptions {
  db: PrismaClient;
  /** `EXPORT_DIR`, default `./exports` (ADR-0009 §2). */
  dir: string;
  log: ExporterLog;
}

export interface Exporter {
  /** One pass: every `finished` session with no `exports` row and at least
   * one non-`drivers` event gets exported; one with no timing events is
   * skipped and re-checked on a later pass. A session that already has an
   * `exports` row is re-exported the same way when `events` holds a row
   * received after that row's `exported_at`. */
  runOnce(): Promise<void>;
  /** Write `<dir>/<sessionKey>.json.gz` with `exportedAt` embedded as
   * `exported_at`. Does not touch the `exports` row -- callers that create
   * or already hold one do that themselves. */
  exportSession(sessionKey: bigint, exportedAt: Date): Promise<void>;
  /** Start the exporter's own 5s tick. Idempotent. */
  start(): void;
  /** Stop the tick, if running. Safe to call with none. */
  stop(): void;
}

// "findMany in pages of 5000 by seq cursor; never load a whole race into
// one query".
const PAGE_SIZE = 5000;
const TICK_MS = 5000;

function filePath(dir: string, sessionKey: bigint): string {
  return join(dir, `${sessionKey.toString()}.json.gz`);
}

/** Every `events` row for `sessionKey`, in `seq` order, paged so no single
 * query loads a whole race (a race is ~28k events, ADR-0009 "Consequences"). */
async function readAllEvents(db: PrismaClient, sessionKey: bigint): Promise<RaceEvent[]> {
  const events: RaceEvent[] = [];
  let cursor = 0n;
  for (;;) {
    const page = await db.event.findMany({
      where: { sessionKey, seq: { gt: cursor } },
      orderBy: { seq: "asc" },
      take: PAGE_SIZE,
      select: { seq: true, eventId: true, endpoint: true, sourceTime: true, payload: true },
    });
    for (const row of page) {
      events.push({
        event_id: row.eventId,
        endpoint: row.endpoint,
        source_time: row.sourceTime?.toISOString() ?? null,
        payload: row.payload as RawRecord,
      });
    }
    const last = page[page.length - 1];
    if (last === undefined || page.length < PAGE_SIZE) break;
    cursor = last.seq;
  }
  return events;
}

/** ADR-0009 §1, exactly: `schema`, top-level `exported_at`, the session
 * fields, and `events` -- the four `RaceEvent` fields the fold reads
 * (`packages/domain`), nothing else. BigInt keys serialise as numbers. */
function buildDoc(session: Session, exportedAt: Date, events: RaceEvent[]): RaceFile {
  return {
    schema: 1,
    exported_at: exportedAt.toISOString(),
    session: {
      session_key: Number(session.sessionKey),
      name: session.name,
      country: session.country,
      circuit_key: session.circuitKey,
      date_start: session.dateStart.toISOString(),
      date_end: session.dateEnd.toISOString(),
      total_laps: session.totalLaps,
      status: session.status,
      meeting_name: session.meetingName,
      circuit_short_name: session.circuitShortName,
      location: session.location,
    },
    events,
  };
}

export function createExporter(opts: ExporterOptions): Exporter {
  const { db, dir, log } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  // "logged once per process" -- a skip that stays a skip must not spam the
  // log on every 5s tick; a session that gains timing data is exported on
  // the tick it does, so there is nothing to clear this for.
  const loggedSkips = new Set<string>();

  async function exportSession(sessionKey: bigint, exportedAt: Date): Promise<void> {
    const session = await db.session.findUniqueOrThrow({ where: { sessionKey } });
    const events = await readAllEvents(db, sessionKey);
    const doc = buildDoc(session, exportedAt, events);

    await mkdir(dir, { recursive: true });
    const finalPath = filePath(dir, sessionKey);
    const tmpPath = `${finalPath}.tmp`;
    // Gzip stream to the temp path, then rename -- a reader never observes a
    // partially written file (ADR-0009 §2 "atomically (temp file, then rename)").
    await pipeline(Readable.from([JSON.stringify(doc)]), createGzip(), createWriteStream(tmpPath));
    await rename(tmpPath, finalPath);
  }

  async function runOnce(): Promise<void> {
    // One query per tick, regardless of session or viewer count (ADR-0001
    // §2 invariant 2): new candidates (finished, no `exports` row) and
    // stale candidates (finished, `events` gained a row after
    // `exported_at`) unioned in one statement. See README: Exports.
    const candidates = await db.$queryRaw<
      Array<{ session_key: string; exported_at: Date | null; path: string | null }>
    >`
      SELECT s.session_key::text AS session_key, NULL::timestamp(3) AS exported_at, NULL::text AS path
      FROM sessions s
      WHERE s.status = 'finished'
        AND NOT EXISTS (SELECT 1 FROM exports e WHERE e.session_key = s.session_key)

      UNION ALL

      SELECT s.session_key::text AS session_key, e.exported_at AS exported_at, e.path AS path
      FROM sessions s
      JOIN exports e ON e.session_key = s.session_key
      WHERE s.status = 'finished'
        AND EXISTS (
          SELECT 1 FROM events ev
          WHERE ev.session_key = s.session_key AND ev.received_at > e.exported_at
        )
    `;

    for (const candidate of candidates) {
      const sessionKey = BigInt(candidate.session_key);
      const stale = candidate.exported_at !== null;

      if (!stale) {
        // A brand-new candidate: does this session have any event that is
        // not `drivers`? A finished session with none is skipped -- no
        // `exports` row is created, so the next tick re-checks it. A stale
        // candidate already has an `exports` row, so it already passed this
        // check the first time it was exported.
        const timingEvent = await db.event.findFirst({
          where: { sessionKey, endpoint: { not: "drivers" } },
          select: { seq: true },
        });
        if (timingEvent === null) {
          const key = sessionKey.toString();
          if (!loggedSkips.has(key)) {
            loggedSkips.add(key);
            log(`export skipped ${key}: no timing events`);
          }
          continue;
        }
      }

      // Computed once: embedded in the file, stored in the row, and later
      // used by the etag (ADR-0009 §2) -- they cannot diverge.
      const exportedAt = new Date();
      const path = filePath(dir, sessionKey);
      try {
        await exportSession(sessionKey, exportedAt);
        if (stale) {
          await db.export.update({ where: { sessionKey }, data: { exportedAt, path } });
          log(`export re-exported ${sessionKey.toString()}`, { exportedAt: exportedAt.toISOString() });
        } else {
          await db.export.create({ data: { sessionKey, exportedAt, path } });
        }
      } catch (err) {
        // "Any failure: log `export failed` with the key and error, leave
        // the row (absent for a new session, unchanged for a stale one),
        // continue with the next session." Temp-then-rename means a write
        // failure never leaves a partial file either.
        log("export failed", { sessionKey: sessionKey.toString(), error: String(err) });
      }
    }
  }

  return {
    runOnce,
    exportSession,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        if (inFlight) return; // non-overlapping: a tick started mid-runOnce returns
        inFlight = true;
        void runOnce()
          .catch((err: unknown) => log("exporter tick failed", { error: String(err) }))
          .finally(() => {
            inFlight = false;
          });
      }, TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
