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
import { createFileFetcher, readRecordingEndpoint } from "./openf1/file-fetcher.js";
import type { RecordedRow } from "./openf1/file-fetcher.js";
import { LiveNormalizer } from "./openf1/normalize.js";
import { OPENF1_BASE, POLL_ROTATION, emitRows } from "./openf1/rest-lane.js";
import type { QueueItem, RawRecord } from "./openf1/types.js";
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
// emitted separately, first, "exactly as session selection does". This list
// is still the read order for `raw/*.jsonl` files (issue #77 below reorders
// only the *emitted* order, by `received_at`).
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

// Issue #77: a bulk read of a complete recording emitted one endpoint fully
// before the next, so a loaded session's `events.seq` ended up blocked by
// endpoint instead of following time — every `laps` row landed after every
// `position`/`intervals` row, which the browser fold (`foldAt`, seq order up
// to `source_time`) reads as "no lap yet" for most of the race. Fix: read
// every endpoint's rows (with `received_at`, via `readRecordingEndpoint`)
// and emit them in `received_at` order instead, reproducing the order live
// capture would have produced. When two rows tie exactly on `received_at`,
// break the tie by endpoint using `POLL_ROTATION`'s order (rest-lane.ts) —
// the order one live poll cycle visits them in; `drivers` never appears in
// `POLL_ROTATION` (fetched once at session selection, not polled), so it
// keeps its `RECORDING_ENDPOINT_ORDER` position, first. Do not touch
// `RestLane` — the live REST lane already emits in time order, one poll's
// rows at a time; only a bulk recording load needs this sort (see the
// scope note on issue #77: `replay.integration.test.ts`'s per-endpoint
// block order is expected there too, and is unaffected by this fix).
const ENDPOINT_TIE_BREAK_ORDER: readonly string[] = [
  "drivers",
  ...POLL_ROTATION.filter((endpoint, index) => POLL_ROTATION.indexOf(endpoint) === index),
];

function endpointTieBreakIndex(endpoint: string): number {
  const index = ENDPOINT_TIE_BREAK_ORDER.indexOf(endpoint);
  return index === -1 ? ENDPOINT_TIE_BREAK_ORDER.length : index;
}

/**
 * Reads every `RECORDING_ENDPOINT_ORDER` endpoint's rows for one session and
 * merges them into `received_at` order (stable): ties within one endpoint
 * keep file order (the per-endpoint arrays are read and concatenated in
 * order, untouched by the first sort); ties across endpoints keep
 * `ENDPOINT_TIE_BREAK_ORDER`'s order, because that first sort — grouping by
 * endpoint before the stable `received_at` sort — is what a same-key stable
 * sort preserves.
 */
async function readSessionRowsInTimeOrder(dir: string, sessionKey: number): Promise<RecordedRow[]> {
  const perEndpoint = await Promise.all(
    RECORDING_ENDPOINT_ORDER.map((endpoint) => readRecordingEndpoint(dir, sessionKey, endpoint)),
  );
  const byEndpointOrder = RECORDING_ENDPOINT_ORDER.map((endpoint, index) => ({
    endpoint,
    rows: perEndpoint[index]!,
  }))
    .sort((a, b) => endpointTieBreakIndex(a.endpoint) - endpointTieBreakIndex(b.endpoint))
    .flatMap((group) => group.rows);

  // Array.prototype.sort is stable (ES2019+): rows with an equal (or both
  // missing) `received_at` keep the relative order `byEndpointOrder` above
  // already gave them.
  return byEndpointOrder.sort((a, b) => {
    const aMs = a.receivedAt ? Date.parse(a.receivedAt) : Number.POSITIVE_INFINITY;
    const bMs = b.receivedAt ? Date.parse(b.receivedAt) : Number.POSITIVE_INFINITY;
    return aMs - bMs;
  });
}

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
   * Sessions not written, or not fully written: a malformed row (round 1
   * fix — caught in `loadRecordings`'s per-session loop, not here); refused
   * as live (ADR-0010 — returned as `{ skipped: true }` below); or the
   * writer gave up on the session's events after repeated failures (issue
   * #71 — the row is left `upcoming`, not written, for the next run to
   * finish; also `{ skipped: true }`).
   */
  sessionsSkipped: number;
}

export interface WriteSessionThroughLoaderResult {
  skipped: boolean;
  /** What this session's own drain wrote — folded into the running total by the caller. */
  drainResult: DrainResult;
}

/**
 * The write path shared by the recording loader and `fetch-race` (issue
 * #88, ADR-0009: "a fetched race reaches the exporter the same way a loaded
 * one does"): validate the session key, apply the ADR-0010 live guard,
 * upsert `upcoming` (unless already `finished`), let `emitAll` push every
 * event onto `queue` (via a fresh `LiveNormalizer` it is handed, per
 * behaviour "normalise every row with the same LiveNormalizer"), drain, and
 * only then upsert `finished` (issue #71's ordering — see the inline
 * comments below, unchanged from before this was pulled out of
 * `loadOneSession`).
 */
export async function writeSessionThroughLoader(
  session: RawRecord,
  db: LoaderDb,
  writer: EventWriter,
  queue: EventQueue<QueueItem>,
  nowMs: number,
  log: (line: string) => void,
  emitAll: (normalizer: LiveNormalizer, sessionKey: number, alreadyFinished: boolean) => Promise<void>,
): Promise<WriteSessionThroughLoaderResult> {
  const noEvents: DrainResult = { inserted: 0, skipped: 0 };
  const sessionKey = Number(session["session_key"]);
  if (!Number.isFinite(sessionKey)) {
    log(`load: session skipped, invalid session_key: ${JSON.stringify(session["session_key"])}`);
    return { skipped: true, drainResult: noEvents };
  }

  // ADR-0010: the single-writer guarantee (ADR-0007) is per session, not
  // per process — the live `ingest` service owns any session inside its
  // live window; the loader (and `fetch-race`) owns only sessions whose
  // window has closed. Two checks, both against a *live* verdict: the
  // session's own dates (it can be loaded/fetched before its window has
  // actually ended, e.g. a stale/partial capture), and any existing
  // `sessions` row (in case the live service is still tracking it under
  // different dates). `sessionFieldsFromRaw` also validates
  // `date_start`/`date_end` — a malformed date throws here and is caught by
  // the caller (round 1 fix), same as it always was inside `upsertSession`.
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

  // Round-3 review fix (issue #39, owner ruling): the two checks above only
  // refuse a session already `live`. ADR-0010 §1, quoted verbatim: "The
  // single-writer guarantee holds per `session_key`: at most one process
  // writes rows for a given session. The live `ingest` service owns every
  // session inside its live window; the loader owns only sessions whose
  // window has closed." A window that hasn't closed yet also covers
  // `upcoming` (not live YET, but the live service will start owning that
  // SAME session_key once its window opens) — the checks above let an
  // `upcoming` session through unrefused, and issue #39's Friday/pre-race
  // `drivers` fetches are the first thing that made that reachable in
  // practice: they write rows for a session while it is still `upcoming`,
  // which the live service could then race against this loader/fetch-race
  // run for the same session_key. `fields.status` is "live" only when
  // ADR-0010 already refused above, so by this point it is "upcoming" or
  // "finished" — refuse whenever it isn't "finished" (the window hasn't
  // closed).
  if (fields.status !== "finished") {
    log(`load: refused ${sessionKey}: window not closed; the live ingest service owns it`);
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
  //
  // Round 1 fix (PR #74 review): skip that `upcoming` upsert when the row is
  // already `finished` — a rerun of an already-loaded recording (idempotent
  // by design; see `loadRecordings`'s doc comment) must not visibly demote a
  // finished session back to `upcoming` and then straight back to
  // `finished`. The final `upsertSession(..., { status: "finished" })` below
  // still runs either way, so the net effect is unchanged: still finished.
  const alreadyFinished = existing?.status === "finished";
  if (!alreadyFinished) {
    await upsertSession(db, session, nowMs, { status: "upcoming" });
  }

  const normalizer = new LiveNormalizer();
  // `alreadyFinished` is handed to `emitAll` too (issue #88 round 1 fix):
  // this write path always re-fetches/re-normalizes on a rerun (DB-level
  // idempotency comes from `event.createMany({ skipDuplicates: true })`
  // downstream, not from skipping the work here) — but a caller with its
  // own side effect keyed off "is this actually new" (fetch-race.ts's jsonl
  // recording) needs to know a rerun when it sees one, since a fresh
  // `LiveNormalizer` per call means every row looks "new" to it again.
  await emitAll(normalizer, sessionKey, alreadyFinished);

  // Issue #71: wait for every queued event to actually commit before
  // flipping the row to `finished` — the whole point of the reordering
  // above. `drainAll()` retries a failing batch a few times, then gives up
  // and returns without throwing, leaving the failed batch requeued at the
  // front (writer.ts); `!queue.isEmpty()` is how that give-up is detected
  // here.
  const drainResult = await writer.drainAll();
  if (!queue.isEmpty()) {
    // Round 1 fix (PR #74 review): the queue and writer are shared across
    // every session in this `loadRecordings()` call, and a batch that gave
    // up is left sitting at the FRONT of the queue (requeueFront in
    // writer.ts) — the next session's own `drainAll()` would hit that stuck
    // batch first (or get merged into the same batch, since drain isn't
    // session-aware) and be wrongly marked skipped for a failure that was
    // never its own. Clear it here so the failure stays attributed to
    // *this* session and the next one starts from an empty queue.
    const dropped = queue.clear();
    log(`load: dropped ${dropped} unwritten rows for ${sessionKey}`);
    log(
      `load: session=${sessionKey} writer failed to write all events; session left upcoming for the next run`,
    );
    return { skipped: true, drainResult };
  }

  // Every event for this session has committed — only now is it safe to
  // mark the session `finished`. If the process had died anywhere above,
  // the row stays `upcoming`, the exporter never touches it (ADR-0009 §2),
  // and the next `pnpm ingest:load` (or `pnpm ingest:fetch-race`) of the
  // same session finishes it — idempotent, per `loadRecordings`'s own doc
  // comment above.
  await upsertSession(db, session, nowMs, { status: "finished" });

  return { skipped: false, drainResult };
}

type LoadOneSessionResult = WriteSessionThroughLoaderResult;

async function loadOneSession(
  dir: string,
  session: RawRecord,
  db: LoaderDb,
  writer: EventWriter,
  queue: EventQueue<QueueItem>,
  nowMs: number,
  log: (line: string) => void,
): Promise<LoadOneSessionResult> {
  return writeSessionThroughLoader(session, db, writer, queue, nowMs, log, async (normalizer, sessionKey) => {
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

    // Issue #77: emit in `received_at` order across every endpoint, not one
    // endpoint's rows fully before the next — see
    // `readSessionRowsInTimeOrder` above. Consecutive rows that share an
    // endpoint are still batched into one `emitRows` call each (same
    // identity/dedup path, fewer/larger writer batches and log lines than
    // one row at a time); only the batch boundaries move, not the per-row
    // order within/across batches.
    const merged = await readSessionRowsInTimeOrder(dir, sessionKey);
    let mergedIndex = 0;
    while (mergedIndex < merged.length) {
      const endpoint = merged[mergedIndex]!.endpoint;
      const rows: RawRecord[] = [];
      while (mergedIndex < merged.length && merged[mergedIndex]!.endpoint === endpoint) {
        rows.push(merged[mergedIndex]!.payload);
        mergedIndex += 1;
      }
      const result = emitRows(normalizer, queue, endpoint, sessionKey, rows);
      log(`load: session=${sessionKey} endpoint=${endpoint} rows=${rows.length} new=${result.newRows}`);
    }
  });
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
        const result = await loadOneSession(dir, session, db, writer, queue, nowMs, log);
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
