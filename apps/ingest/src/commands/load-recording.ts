// load-recording (ADR-0009): writes a POC recording into `sessions` +
// `events` as a finished session, reusing the live service's normalizer,
// queue, writer, and `upsertSession` (ADR-0007 §1). See README:
// Recording load. Usage: `pnpm ingest:load [--replace] <recording-dir>
// [<recording-dir> ...]`.

import type { SessionStatus } from "@formula-time/db";
import { createDb } from "@formula-time/db";

import { ENTRY_LIST_2026 } from "../openf1/entry-list.js";
import { OpenF1Auth, createOpenF1Fetcher, credentialsFromEnv } from "../openf1/auth.js";
import { enqueueRows } from "../openf1/enqueue.js";
import { createFileFetcher, readRecordingEndpoint } from "../openf1/file-fetcher.js";
import type { RecordedRow } from "../openf1/file-fetcher.js";
import { LiveNormalizer } from "../openf1/normalize.js";
import { FETCH_SPACING_MS, withRetry, withSpacing } from "../openf1/rate-limit.js";
import { OPENF1_BASE, POLL_ROTATION } from "../openf1/rest-lane.js";
import type { Fetcher, QueueItem, RawRecord } from "../openf1/types.js";
import { EventQueue } from "../writer/queue.js";
import type { DrainResult, EventWriterDb } from "../writer/writer.js";
import { EventWriter } from "../writer/writer.js";
import type { SessionsDb } from "../writer/sessions.js";
import { isRaceSession, sessionFieldsFromRaw, upsertSession } from "../writer/sessions.js";

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

/** `--replace`'s delete half: clears a session's `events` rows before the reload's insert path runs. */
export interface EventDeleteDb {
  event: {
    deleteMany(args: { where: { sessionKey: bigint } }): Promise<{ count: number }>;
  };
}

/** The verify line's read-back — `seq` order, `endpoint` and `source_time` only, never the payload. */
export interface EventReadDb {
  event: {
    findMany(args: {
      where: { sessionKey: bigint };
      orderBy: { seq: "asc" };
      select: { endpoint: true; sourceTime: true };
    }): Promise<Array<{ endpoint: string; sourceTime: Date | null }>>;
  };
}

/**
 * `--replace` runs the delete and the reload's insert path as one
 * transaction, so a failed insert rolls the delete back too and the
 * session's old rows are left exactly as they were.
 */
export interface EventTransactionDb {
  $transaction<T>(
    fn: (tx: EventWriterDb & EventDeleteDb) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
}

/** The slice of the Prisma client the loader needs — real client or a fake (unit test). */
export type LoaderDb = SessionsDb & EventWriterDb & SessionStatusReader & EventDeleteDb & EventReadDb & EventTransactionDb;

// Reads every `raw/*.jsonl` through the same `LiveNormalizer` in this
// file order; "drivers" here is the recorded OpenF1 fetch
// (`raw/drivers.jsonl`), distinct from the static `ENTRY_LIST_2026`
// entry list emitted separately, first. See README: Recording load.
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

// Tie-break order for rows sharing a `received_at` across endpoints —
// `drivers` first, then `POLL_ROTATION`'s order (rest-lane.ts). See
// README: Recording load.
const ENDPOINT_TIE_BREAK_ORDER: readonly string[] = [
  "drivers",
  ...POLL_ROTATION.filter((endpoint, index) => POLL_ROTATION.indexOf(endpoint) === index),
];

function endpointTieBreakIndex(endpoint: string): number {
  const index = ENDPOINT_TIE_BREAK_ORDER.indexOf(endpoint);
  return index === -1 ? ENDPOINT_TIE_BREAK_ORDER.length : index;
}

/**
 * Reads every `RECORDING_ENDPOINT_ORDER` endpoint's rows for one session
 * and merges them into `received_at` order (stable). See README:
 * Recording load.
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

/**
 * The two counts the verify line reports: `endpoint_runs` and
 * `source_time_backsteps`. See README: Recording load.
 */
export function verifyCounts(
  rows: readonly { endpoint: string; source_time: Date | string | null }[],
): { rows: number; endpoint_runs: number; source_time_backsteps: number } {
  let endpoint_runs = 0;
  let previousEndpoint: string | null = null;
  let previousSourceTimeMs: number | null = null;
  let source_time_backsteps = 0;

  for (const row of rows) {
    if (row.endpoint !== previousEndpoint) {
      endpoint_runs += 1;
      previousEndpoint = row.endpoint;
    }
    const ms = sourceTimeMs(row.source_time);
    if (ms !== null) {
      if (previousSourceTimeMs !== null && ms < previousSourceTimeMs) source_time_backsteps += 1;
      previousSourceTimeMs = ms;
    }
  }

  return { rows: rows.length, endpoint_runs, source_time_backsteps };
}

function sourceTimeMs(value: Date | string | null): number | null {
  if (value === null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reads a session's own `events` back in `seq` order and logs
 * `verifyCounts` on them, once per load. `endpoint`/`source_time` only,
 * never the payload — a shape check, not a data read.
 */
async function logVerifyLine(db: EventReadDb, sessionKey: number, log: (line: string) => void): Promise<void> {
  const rows = await db.event.findMany({
    where: { sessionKey: BigInt(sessionKey) },
    orderBy: { seq: "asc" },
    select: { endpoint: true, sourceTime: true },
  });
  const counts = verifyCounts(rows.map((row) => ({ endpoint: row.endpoint, source_time: row.sourceTime })));
  log(
    `load: verify ${sessionKey} rows=${counts.rows} endpoint_runs=${counts.endpoint_runs} source_time_backsteps=${counts.source_time_backsteps}`,
  );
}

// A full race is ~28,000 events, ~280 `createMany` batches of 100 — well
// over Prisma's 5s default interactive-transaction timeout. This is
// deliberately generous (minutes, not seconds): intent is "never time out a
// legitimate reload", not a tuned value.
const REPLACE_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `--replace`: deletes a session's `events` rows and drains the queue's
 * already-ordered rows back in, as one transaction. See README:
 * Recording load.
 */
async function replaceSessionEvents(
  db: EventTransactionDb,
  queue: EventQueue<QueueItem>,
  sessionKey: bigint,
  log: (message: string) => void,
): Promise<DrainResult> {
  return db.$transaction(
    async (tx) => {
      await tx.event.deleteMany({ where: { sessionKey } });
      const txWriter = new EventWriter(tx, queue, { log });
      const result = await txWriter.drainAll();
      // `drainAll()` gives up after repeated failures without throwing,
      // leaving the failed batch on the queue — throwing here is what rolls
      // the delete back too, instead of committing a session with its old
      // rows gone and the new ones only partially written.
      if (!queue.isEmpty()) {
        throw new Error(`replace: writer failed to write all events for session ${sessionKey}`);
      }
      return result;
    },
    { timeout: REPLACE_TRANSACTION_TIMEOUT_MS, maxWait: REPLACE_TRANSACTION_TIMEOUT_MS },
  );
}

export interface LoadRecordingsOptions {
  now?: () => number;
  onLog?: (line: string) => void;
  /** Reload a session in place: delete its `events` rows, then the normal insert path, as one transaction. */
  replace?: boolean;
  /**
   * A live OpenF1 fetcher, used only as a fallback to source
   * `meeting_name`. See README: Recording load. `undefined` here means
   * "no fallback" — a unit test can pin the file-only path.
   */
  meetingsFetcher?: Fetcher | undefined;
}

export interface LoadRecordingsResult {
  inserted: number;
  skipped: number;
  /** Sessions the loader tried to load, across every `dir`. */
  sessionsAttempted: number;
  /**
   * Sessions not written, or not fully written: a malformed row, a
   * refusal (ADR-0010), or a writer give-up leaving the row `upcoming`
   * for the next run. See README: Recording load.
   */
  sessionsSkipped: number;
}

export interface WriteSessionThroughLoaderResult {
  skipped: boolean;
  /** What this session's own drain wrote — folded into the running total by the caller. */
  drainResult: DrainResult;
}

export interface WriteSessionThroughLoaderOptions {
  /**
   * Reload this session in place: delete its `events` rows and run the
   * insert path as one transaction. See README: Recording load.
   */
  replace?: boolean;
}

/**
 * The write path shared by the recording loader and `fetch-race`. See
 * README: Recording load.
 */
export async function writeSessionThroughLoader(
  session: RawRecord,
  db: LoaderDb,
  writer: EventWriter,
  queue: EventQueue<QueueItem>,
  nowMs: number,
  log: (line: string) => void,
  getMeetingNames: () => Promise<ReadonlyMap<number, string>>,
  emitAll: (normalizer: LiveNormalizer, sessionKey: number, alreadyFinished: boolean) => Promise<void>,
  opts: WriteSessionThroughLoaderOptions = {},
): Promise<WriteSessionThroughLoaderResult> {
  const noEvents: DrainResult = { inserted: 0, skipped: 0 };
  const sessionKey = Number(session["session_key"]);
  if (!Number.isFinite(sessionKey)) {
    log(`load: session skipped, invalid session_key: ${JSON.stringify(session["session_key"])}`);
    return { skipped: true, drainResult: noEvents };
  }

  // Only race sessions are loaded, refused here before any write
  // (including before the `--replace` delete) — `isRaceSession` is the
  // one shared predicate so the REST lane, this loader, and `fetch-race`
  // all agree on what counts as a race.
  if (!isRaceSession(session)) {
    log(`load: refused ${sessionKey}: session_name is "${String(session["session_name"])}", only "Race" is loaded`);
    return { skipped: true, drainResult: noEvents };
  }

  // ADR-0010 live guard, two checks against a *live* verdict — the
  // session's own dates and any existing `sessions` row. See README:
  // Recording load. `sessionFieldsFromRaw` also validates
  // `date_start`/`date_end`; a malformed date throws here, caught by the
  // caller.
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

  // The two checks above only refuse a session already `live`; an
  // `upcoming` session is also refused — the live service will start
  // owning it once its window opens, and the Friday/pre-race `drivers`
  // fetches already write rows for it. See README: Recording load.
  if (fields.status !== "finished") {
    log(`load: refused ${sessionKey}: window not closed; the live ingest service owns it`);
    return { skipped: true, drainResult: noEvents };
  }

  // ADR-0009 §2: upserts `upcoming` first, not `finished`, so the
  // exporter's 5s tick never sees a finished row with no events yet — a
  // rerun of an already-`finished` session skips this step. See README:
  // Recording load. Every guard above has passed, so only now is a
  // meetings request actually spent on this session.
  const meetingNames = await getMeetingNames();

  const alreadyFinished = existing?.status === "finished";
  if (!alreadyFinished) {
    await upsertSession(db, session, nowMs, { status: "upcoming", meetingNames });
  }

  const normalizer = new LiveNormalizer();
  // `alreadyFinished` is handed to `emitAll` too, so a caller with its
  // own new-vs-rerun side effect (fetch-race.ts's jsonl recording) can
  // tell — this path always re-fetches/re-normalizes on a rerun.
  await emitAll(normalizer, sessionKey, alreadyFinished);

  // Wait for every queued event to actually commit before
  // flipping the row to `finished` — the whole point of the reordering
  // above. `drainAll()` retries a failing batch a few times, then gives up
  // and returns without throwing, leaving the failed batch requeued at the
  // front (writer.ts); `!queue.isEmpty()` is how that give-up is detected
  // here.
  let drainResult: DrainResult;
  if (opts.replace) {
    try {
      drainResult = await replaceSessionEvents(db, queue, BigInt(sessionKey), log);
    } catch (error) {
      // The transaction rolled back: the delete never committed, so the
      // session's old rows are exactly as they were. Whatever's left on the
      // queue was never written either — clear it for the same
      // cross-session reason as the non-replace branch below.
      const dropped = queue.clear();
      log(`load: dropped ${dropped} unwritten rows for ${sessionKey}`);
      log(
        `load: session=${sessionKey} replace transaction rolled back, old rows unchanged: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { skipped: true, drainResult: noEvents };
    }
  } else {
    drainResult = await writer.drainAll();
    if (!queue.isEmpty()) {
      // A batch that gave up sits at the queue's front (requeueFront);
      // the next session's own drainAll() would hit it first and be
      // wrongly marked skipped for a failure that wasn't its own. Clear
      // it here so the failure stays attributed to this session.
      const dropped = queue.clear();
      log(`load: dropped ${dropped} unwritten rows for ${sessionKey}`);
      log(
        `load: session=${sessionKey} writer failed to write all events; session left upcoming for the next run`,
      );
      return { skipped: true, drainResult };
    }
  }

  // The rows this session ends this run with, read back in `seq` order —
  // printed whether or not `--replace` was used, so an endpoint-grouped
  // load is visible in the log without a manual query.
  await logVerifyLine(db, sessionKey, log);

  // Every event for this session has committed — only now is it safe to
  // mark the session `finished`. If the process had died anywhere above,
  // the row stays `upcoming`, the exporter never touches it (ADR-0009 §2),
  // and the next `pnpm ingest:load` (or `pnpm ingest:fetch-race`) of the
  // same session finishes it — idempotent, per `loadRecordings`'s own doc
  // comment above.
  await upsertSession(db, session, nowMs, { status: "finished", meetingNames });

  return { skipped: false, drainResult };
}

/**
 * `raw/meetings.jsonl` for this one session, via `readRecordingEndpoint`
 * (never the generic `createFileFetcher` URL dispatch, which would find
 * only a shared, session-key-less file). See README: Recording load.
 */
async function meetingNamesFromRecording(
  dir: string,
  sessionKey: number,
  meetingKey: number,
): Promise<ReadonlyMap<number, string>> {
  const rows = await readRecordingEndpoint(dir, sessionKey, "meetings");
  const match = rows.find((row) => Number(row.payload["meeting_key"]) === meetingKey);
  const name = match?.payload["meeting_name"];
  return typeof name === "string" && name.length > 0 ? new Map([[meetingKey, name]]) : new Map();
}

/**
 * The meeting-name fallback: the recording's own `raw/meetings.jsonl`
 * first, then one live `meetings?meeting_key=` call if given a fetcher.
 * See README: Recording load.
 */
async function meetingNamesForSession(
  dir: string,
  sessionKey: number,
  session: RawRecord,
  meetingsFetcher: Fetcher | undefined,
  log: (line: string) => void,
): Promise<ReadonlyMap<number, string>> {
  const meetingKey = Number(session["meeting_key"]);
  if (!Number.isFinite(meetingKey)) return new Map();

  const fromFile = await meetingNamesFromRecording(dir, sessionKey, meetingKey);
  if (fromFile.size > 0) return fromFile;

  if (!meetingsFetcher) {
    log(`load: session=${sessionKey} no meeting_name source (no raw/meetings.jsonl and no meetingsFetcher given)`);
    return new Map();
  }

  try {
    const raw = await meetingsFetcher(`${OPENF1_BASE}/meetings?meeting_key=${meetingKey}`);
    const rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
    const match = rows.find((row) => Number(row["meeting_key"]) === meetingKey);
    const name = match?.["meeting_name"];
    if (typeof name === "string" && name.length > 0) return new Map([[meetingKey, name]]);
    log(`load: session=${sessionKey} live meetings fetch for meeting_key=${meetingKey} returned no usable meeting_name`);
    return new Map();
  } catch (error) {
    log(
      `load: live meetings fetch failed for meeting_key=${meetingKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }
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
  replace: boolean,
  meetingsFetcher: Fetcher | undefined,
): Promise<LoadOneSessionResult> {
  const sessionKeyForMeetings = Number(session["session_key"]);
  return writeSessionThroughLoader(
    session,
    db,
    writer,
    queue,
    nowMs,
    log,
    async () =>
      Number.isFinite(sessionKeyForMeetings)
        ? meetingNamesForSession(dir, sessionKeyForMeetings, session, meetingsFetcher, log)
        : new Map<number, string>(),
    async (normalizer, sessionKey) => {
      // The static entry list, "exactly as session selection does" (same
      // `enqueueRows` path rest-lane.ts's `ensureLiveSession` uses) — so the
      // `drivers` event ids match a live run of the same session.
      const driverRows: RawRecord[] = ENTRY_LIST_2026.map((driver) => ({
        session_key: sessionKey,
        driver_number: driver.driver_number,
        full_name: driver.full_name,
        name_acronym: driver.name_acronym,
        team_name: driver.team_name,
        team_colour: driver.team_colour,
      }));
      const entryResult = await enqueueRows(normalizer, queue, "drivers", sessionKey, driverRows);
      log(
        `load: session=${sessionKey} endpoint=drivers(entry-list) rows=${driverRows.length} new=${entryResult.newRows}`,
      );

      // Emitted in `received_at` order across endpoints (see README:
      // Recording load), batched into one `enqueueRows` call per
      // consecutive same-endpoint run — only batch boundaries move, not
      // per-row order.
      const merged = await readSessionRowsInTimeOrder(dir, sessionKey);
      let mergedIndex = 0;
      while (mergedIndex < merged.length) {
        const endpoint = merged[mergedIndex]!.endpoint;
        const rows: RawRecord[] = [];
        while (mergedIndex < merged.length && merged[mergedIndex]!.endpoint === endpoint) {
          rows.push(merged[mergedIndex]!.payload);
          mergedIndex += 1;
        }
        const result = await enqueueRows(normalizer, queue, endpoint, sessionKey, rows);
        log(`load: session=${sessionKey} endpoint=${endpoint} rows=${rows.length} new=${result.newRows}`);
      }
    },
    { replace },
  );
}

/**
 * Loads one or more POC recordings into `sessions` + `events`. Each
 * `dir` is a single recording or a root holding several — see
 * `createFileFetcher`. Every row for one session drains before that
 * session flips to `finished`; idempotent via `skipDuplicates`.
 */
export async function loadRecordings(
  dirs: string[],
  db: LoaderDb,
  opts: LoadRecordingsOptions = {},
): Promise<LoadRecordingsResult> {
  const now = opts.now ?? Date.now;
  const log = opts.onLog ?? ((line: string) => console.log(line));
  const replace = opts.replace ?? false;
  const meetingsFetcher = opts.meetingsFetcher;

  const queue = new EventQueue<QueueItem>();
  const writer = new EventWriter(db, queue, { log });

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
        const result = await loadOneSession(dir, session, db, writer, queue, nowMs, log, replace, meetingsFetcher);
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
        // Needed per session since draining happens inside
        // `loadOneSession`: whatever made it onto the queue before a
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

// CLI entry: `node dist/commands/load-recording.js [--replace] <recording-dir>
// [<recording-dir> ...]` (package.json script "load"; root script
// "ingest:load"). Guarded so this module can be imported by the unit test
// without running the CLI.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const replace = argv.includes("--replace");
  const dirs = argv.filter((arg) => arg !== "--replace");
  if (dirs.length === 0) {
    console.error("load-recording: usage: pnpm ingest:load [--replace] <recording-dir> [<recording-dir> ...]");
    process.exit(1);
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("load-recording: DATABASE_URL is not set; refusing to start (ADR-0004 config seam).");
    process.exit(1);
  }
  const db = createDb(databaseUrl, { max: 1 });
  // The live meetings fallback (meetingNamesForSession's doc comment):
  // historical meetings data is public, so this works whether or not
  // OPENF1_LOGIN/PASSWORD are configured (OpenF1Auth(null) sends no bearer
  // token) — rate-limited the same way fetch-race's own live requests are.
  const meetingsFetcher = withRetry(withSpacing(createOpenF1Fetcher(new OpenF1Auth(credentialsFromEnv())), FETCH_SPACING_MS));
  loadRecordings(dirs, db, { replace, meetingsFetcher })
    .then(async (result) => {
      await db.$disconnect();
      // Exit 1 only if every attempted session failed/was refused — a
      // partial load (some sessions good, some skipped) still
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
