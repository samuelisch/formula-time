// The exporter (ADR-0009 §2, HLD §7 "Export"): "Export = once, when
// status = finished and exported_at IS NULL; idempotent; retried by the
// same check. No separate job." ADR-0009 amends the check to "no `exports`
// row" (`sessions.exported_at` is dropped) but keeps the mechanics: on its
// own 5s tick, write the immutable file once and record it.
//
// "Table ownership holds. ADR-0004 and HLD §4 give every table exactly one
// writer, and ingest owns `sessions`. So the api does not write `sessions`:
// the export record lives in a fifth table, `exports` ... written only by
// the api." (ADR-0009 §2) -- this module is that writer.
//
// "Disk is a cache, the database is the record." (ADR-0009 §3) -- when a
// request finds an `exports` row but the file missing, the api regenerates
// it "same code path, same embedded `exported_at`". That is why
// `exportSession(sessionKey, exportedAt)` is exported standalone: `runOnce`
// calls it with a freshly computed timestamp before inserting the row;
// the historical-race route calls it again, later, with the row's stored
// timestamp, and never touches the row itself.
//
// Own 5s timer, independent of `session-lifecycle.ts`: `start()`/`stop()`
// manage a `setInterval`, `unref`'d so it never keeps the process alive.
// Ticks never overlap -- a tick that starts while a previous `runOnce` is
// still awaiting returns immediately, the same "never more than one pass of
// work in flight" shape as the projector's own tick (ADR-0001 §2 invariant 2).
//
// Precondition on top of ADR-0009 §2's "export once when finished" (refines
// it, does not contradict it -- §2 never says every finished session has
// timing data): "A finished session is exported only when it has at least
// one event whose endpoint is not `drivers` (that is, timing data to
// replay). A session with no timing events is skipped, logged once per
// process as `export skipped <key>: no timing events`, and re-checked on
// later ticks so a late load still exports it." A practice/qualifying
// session whose only ingest activity was the `drivers` endpoint (or none at
// all) has nothing for the browser fold to replay, so it never gets an
// `exports` row and never shows up in `GET /api/races`.
import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { PrismaClient, Session } from "@formula-time/db";

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
   * skipped and re-checked on a later pass. */
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

interface ExportEvent {
  event_id: string;
  endpoint: string;
  source_time: string | null;
  payload: unknown;
}

interface ExportDoc {
  schema: 1;
  exported_at: string;
  session: {
    session_key: number;
    name: string;
    country: string;
    circuit_key: number;
    date_start: string;
    date_end: string;
    total_laps: number | null;
    status: string;
  };
  events: ExportEvent[];
}

function filePath(dir: string, sessionKey: bigint): string {
  return join(dir, `${sessionKey.toString()}.json.gz`);
}

/** Every `events` row for `sessionKey`, in `seq` order, paged so no single
 * query loads a whole race (a race is ~28k events, ADR-0009 "Consequences"). */
async function readAllEvents(db: PrismaClient, sessionKey: bigint): Promise<ExportEvent[]> {
  const events: ExportEvent[] = [];
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
        payload: row.payload,
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
function buildDoc(session: Session, exportedAt: Date, events: ExportEvent[]): ExportDoc {
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
    const candidates = await db.session.findMany({
      where: { status: "finished", export: null },
      select: { sessionKey: true },
    });
    for (const { sessionKey } of candidates) {
      // One cheap query per candidate: does this session have any event
      // that is not `drivers`? A finished session with none is skipped --
      // no `exports` row is created, so the next tick re-checks it.
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

      // Computed once: embedded in the file, stored in the row, and later
      // used by the etag (ADR-0009 §2) -- they cannot diverge.
      const exportedAt = new Date();
      try {
        await exportSession(sessionKey, exportedAt);
        await db.export.create({
          data: { sessionKey, exportedAt, path: filePath(dir, sessionKey) },
        });
      } catch (err) {
        // "Any failure: log `export failed` with the key and error, leave
        // no `exports` row, continue with the next session."
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
