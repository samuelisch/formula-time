// One-shot loader (issue #63, ADR-0009): writes a POC recording into
// `sessions` + `events` as a finished session, so historical races can be
// stored and exported. The live REST lane only polls a session inside its
// ±30 min window (`pickLiveSession` in ./openf1/rest-lane.js), so pointing
// `LIVE_SOURCE` at an old recording discovers and upserts the session but
// never fetches its rows (found in PR #62's smoke) — historical races need
// this explicit load instead.
//
// Lifts the in-process path `replay.integration.test.ts` already exercises
// (file fetcher -> normalizer -> queue -> writer) into a command, per the
// issue body: "lift that path into a command". Reuses `createFileFetcher`,
// `LiveNormalizer` (via the shared `emitRows` pulled out of `rest-lane.ts`),
// `EventQueue`, `EventWriter`, `upsertSession`, and the static
// `ENTRY_LIST_2026` emission — no second writer, no second normalizer, one
// `createDb(url, { max: 1 })` (ADR-0007 §1: "Ingest never updates an
// `events` row."; apps/ingest/AGENTS.md: "Sole writer of the `sessions` and
// `events` tables"). Never touches `polls`, `votes`, or `exports`.
//
// ADR-0010: ADR-0007's single-writer guarantee is per session, not per
// process — this loader is a second connection writing `events`, which is
// only safe because it refuses any session that is (or might still be)
// live; see the guard in loadOneSession() below.
//
// Issue #71: `loadOneSession` upserts each session `upcoming`, writes and
// drains every one of its events, and only then updates the row to
// `finished` — see the comments at each step. Upserting `finished` first
// (the original order) let the api's exporter (ADR-0009 §2) export the
// session the moment the row flipped, before any event existed.

import type { SessionStatus } from "@formula-time/db";
import { createDb } from "@formula-time/db";

import { ENTRY_LIST_2026 } from "./openf1/entry-list.js";
import { createFileFetcher } from "./openf1/file-fetcher.js";
import { LiveNormalizer } from "./openf1/normalize.js";
import { OPENF1_BASE, buildPollUrl, emitRows } from "./openf1/rest-lane.js";
import type { Fetcher, QueueItem, RawRecord } from "./openf1/types.js";
import { EventQueue } from "./writer/queue.js";
import type { DrainResult, EventWriterDb } from "./writer/writer.js";
import { EventWriter } from "./writer/writer.js";
import type { SessionsDb } from "./writer/sessions.js";
import { sessionFieldsFromRaw, upsertSession } from "./writer/sessions.js";

/**
 * The read half of the live-session guard (ADR-0010): whether an *existing*
 * `sessions` row for this key is currently `live`. Kept separate from
 * `SessionsDb` (write-only, used by `RestLane` too) rather than widening
 * that shared interface for one caller.
 */
export interface SessionStatusReader {
  session: {
    findUnique(args: { where: { sessionKey: bigint } }): Promise<{ status: SessionStatus } | null>;
  };
}

/** The slice of the Prisma client the loader needs — real client or a fake (unit test). */
export type LoaderDb = SessionsDb & EventWriterDb & SessionStatusReader;

// Issue #63: "read every `raw/*.jsonl` through the same `LiveNormalizer`
// (identity, dedup) in file order, endpoint order `drivers, position,
// intervals, laps, stints, pit, race_control, weather`". "drivers" here is
// the recorded OpenF1 `drivers` fetch (`raw/drivers.jsonl`, distinct fields
// from the static `ENTRY_LIST_2026` payload below) — the entry list is
// emitted separately, first, "exactly as session selection does".
export const RECORDING_ENDPOINT_ORDER = [
  "drivers",
  "position",
  "intervals",
  "laps",
  "stints",
  "pit",
  "race_control",
  "weather",
] as const;

export interface LoadRecordingsOptions {
  now?: () => number;
  onLog?: (line: string) => void;
}

export interface LoadRecordingsResult {
  inserted: number;
  skipped: number;
  /** Sessions the loader tried to load, across every `dir` (round 1 fix). */
  sessionsAttempted: number;
  /**
   * Sessions not written: a malformed row (round 1 fix — caught in
   * `loadRecordings`'s per-session loop, not here) or refused as live
   * (ADR-0010 — returned as `{ skipped: true }` below).
   */
  sessionsSkipped: number;
}

interface LoadOneSessionResult {
  skipped: boolean;
  /** What this session's own drain wrote — folded into the running total by the caller. */
  drainResult: DrainResult;
}

async function loadOneSession(
  fetcher: Fetcher,
  session: RawRecord,
  db: LoaderDb,
  writer: EventWriter,
  queue: EventQueue<QueueItem>,
  nowMs: number,
  log: (line: string) => void,
): Promise<LoadOneSessionResult> {
  const noEvents: DrainResult = { inserted: 0, skipped: 0 };
  const sessionKey = Number(session["session_key"]);
  if (!Number.isFinite(sessionKey)) {
    log(`load: session skipped, invalid session_key: ${JSON.stringify(session["session_key"])}`);
    return { skipped: true, drainResult: noEvents };
  }

  // ADR-0010: the single-writer guarantee (ADR-0007) is per session, not
  // per process — the live `ingest` service owns any session inside its
  // live window; the loader owns only sessions whose window has closed.
  // Two checks, both against a *live* verdict: the recording's own dates
  // (a directory can be loaded before its own session has actually ended,
  // e.g. a stale/partial capture), and any existing `sessions` row (in
  // case the live service is still tracking it under different dates).
  // `sessionFieldsFromRaw` also validates `date_start`/`date_end` — a
  // malformed date throws here and is caught by the caller (round 1 fix),
  // same as it always was inside `upsertSession`.
  const fields = sessionFieldsFromRaw(session, nowMs);
  if (fields.status === "live") {
    log(`load: refused ${sessionKey}: session is live; the live ingest service owns it`);
    return { skipped: true, drainResult: noEvents };
  }
  const existing = await db.session.findUnique({ where: { sessionKey: BigInt(sessionKey) } });
  if (existing?.status === "live") {
    log(`load: refused ${sessionKey}: session is live; the live ingest service owns it`);
    return { skipped: true, drainResult: noEvents };
  }

  // Issue #71 / ADR-0009 §2: the api's exporter runs on its own 5s tick and
  // exports any `sessions` row with `status = 'finished'` that has no
  // `exports` row yet (HLD §7, quoted: "**Export** = once, when `status =
  // finished` and `exported_at IS NULL`; idempotent; retried by the same
  // check. No separate job."). Upserting `finished` before the events exist
  // let the exporter win the race and write an export with `"events": []`
  // — exports are immutable, so that file had to be deleted by hand. Upsert
  // `upcoming` first instead: it satisfies the `events` FK (the exporter's
  // query ignores `upcoming` rows) without ever exposing a finished session
  // with no events.
  await upsertSession(db, session, nowMs, { status: "upcoming" });

  const normalizer = new LiveNormalizer();

  // The static entry list, "exactly as session selection does" (same
  // `emitRows` path rest-lane.ts's `ensureLiveSession` uses) — so the
  // `drivers` event ids match a live run of the same session.
  const driverRows: RawRecord[] = ENTRY_LIST_2026.map((driver) => ({
    session_key: sessionKey,
    driver_number: driver.driver_number,
    full_name: driver.full_name,
    name_acronym: driver.name_acronym,
    team_name: driver.team_name,
    team_colour: driver.team_colour,
  }));
  const entryResult = emitRows(normalizer, queue, "drivers", sessionKey, driverRows);
  log(
    `load: session=${sessionKey} endpoint=drivers(entry-list) rows=${driverRows.length} new=${entryResult.newRows}`,
  );

  for (const endpoint of RECORDING_ENDPOINT_ORDER) {
    const url = buildPollUrl(endpoint, sessionKey, null);
    const raw = await fetcher(url);
    const rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
    const result = emitRows(normalizer, queue, endpoint, sessionKey, rows);
    log(`load: session=${sessionKey} endpoint=${endpoint} rows=${rows.length} new=${result.newRows}`);
  }

  // Issue #71: wait for every queued event to actually commit before
  // flipping the row to `finished` — the whole point of the reordering
  // above. `drainAll()` retries a failing batch a few times, then gives up
  // and returns without throwing, leaving the failed batch requeued at the
  // front (writer.ts); `!queue.isEmpty()` is how that give-up is detected
  // here.
  const drainResult = await writer.drainAll();
  if (!queue.isEmpty()) {
    log(
      `load: session=${sessionKey} writer failed to write all events; session left upcoming for the next run`,
    );
    return { skipped: true, drainResult };
  }

  // Every event for this session has committed — only now is it safe to
  // mark the session `finished`. If the process had died anywhere above,
  // the row stays `upcoming`, the exporter never touches it (ADR-0009 §2),
  // and the next `pnpm ingest:load` of the same recording finishes it —
  // idempotent, per `loadRecordings`'s own doc comment above.
  await upsertSession(db, session, nowMs, { status: "finished" });

  return { skipped: false, drainResult };
}

/**
 * Loads one or more POC recordings into `sessions` + `events`. Each `dir` is
 * either a single recording (`session.json`, `raw/<endpoint>.jsonl`) or a
 * root holding several (`<dir>/<session_key>/{session.json, raw/...}`) —
 * `createFileFetcher` answers the `sessions` endpoint for both layouts, and
 * routes every later endpoint fetch to the right subdirectory via
 * `session_key`, so this function doesn't need to know which layout it got.
 *
 * Every row for one session is pushed to one shared `EventQueue`, then
 * drained (`writer.drainAll()`) before that session's row is marked
 * `finished` (issue #71) — so draining now happens per session, not once at
 * the very end, though the queue and writer are still shared across every
 * session and `dir`. Idempotent: rows already in the database are skipped
 * by `event.createMany({ skipDuplicates: true })`, not re-inserted.
 */
export async function loadRecordings(
  dirs: string[],
  db: LoaderDb,
  opts: LoadRecordingsOptions = {},
): Promise<LoadRecordingsResult> {
  const now = opts.now ?? Date.now;
  const log = opts.onLog ?? ((line: string) => console.log(line));

  const queue = new EventQueue<QueueItem>();
  const writer = new EventWriter(db, queue);

  let sessionsAttempted = 0;
  let sessionsSkipped = 0;
  let totals: DrainResult = { inserted: 0, skipped: 0 };

  const fold = (result: DrainResult): void => {
    totals = { inserted: totals.inserted + result.inserted, skipped: totals.skipped + result.skipped };
  };

  for (const dir of dirs) {
    const fetcher = createFileFetcher(dir);
    const raw = await fetcher(`${OPENF1_BASE}/sessions`);
    const sessions = Array.isArray(raw) ? (raw as RawRecord[]) : [];
    if (sessions.length === 0) {
      log(`load: no session.json found under ${dir} (single-session or root layout)`);
      continue;
    }
    const nowMs = now();
    for (const session of sessions) {
      sessionsAttempted += 1;
      try {
        const result = await loadOneSession(fetcher, session, db, writer, queue, nowMs, log);
        fold(result.drainResult);
        if (result.skipped) sessionsSkipped += 1;
      } catch (error) {
        sessionsSkipped += 1;
        log(
          `load: session skipped ${String(session["session_key"])}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        // Round 1 fix, still needed per session now that draining happens
        // inside `loadOneSession`: whatever made it onto the queue before a
        // mid-session throw (e.g. a fetch failure partway through the
        // endpoint loop) must still reach the writer. A no-op when
        // `loadOneSession` already drained cleanly — the queue is empty by
        // then, so `drainAll()` returns `{ inserted: 0, skipped: 0 }`.
        fold(await writer.drainAll());
      }
    }
  }

  log(`load: summary inserted=${totals.inserted} skipped=${totals.skipped} skipped_sessions=${sessionsSkipped}`);
  return { ...totals, sessionsAttempted, sessionsSkipped };
}

// CLI entry: `node dist/load-recording.js <recording-dir> [<recording-dir> ...]`
// (package.json script "load"; root script "ingest:load"). Guarded so this
// module can be imported by the unit test without running the CLI.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("load-recording: usage: pnpm ingest:load <recording-dir> [<recording-dir> ...]");
    process.exit(1);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("load-recording: DATABASE_URL is not set; refusing to start (ADR-0004 config seam).");
    process.exit(1);
  }
  const db = createDb(databaseUrl, { max: 1 });
  loadRecordings(dirs, db)
    .then(async (result) => {
      await db.$disconnect();
      // Exit 1 only if every attempted session failed/was refused (round 1
      // fix) — a partial load (some sessions good, some skipped) still
      // wrote what it could, so it exits 0.
      const allFailed = result.sessionsAttempted > 0 && result.sessionsSkipped === result.sessionsAttempted;
      process.exit(allFailed ? 1 : 0);
    })
    .catch(async (error: unknown) => {
      console.error(`load-recording: failed: ${error instanceof Error ? error.message : String(error)}`);
      await db.$disconnect();
      process.exit(1);
    });
}
