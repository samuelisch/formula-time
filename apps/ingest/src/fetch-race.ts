// `fetch-race` — pull one finished historical OpenF1 session straight from
// the live API into `sessions` + `events`, as a one-shot CLI command.
// Historical races are fetched from OpenF1 once and stored, never served on
// demand: finished races are immutable exports, the database is the
// record; the free tier locks the whole API during any live session and
// allows 30 requests a minute.
//
// Reuses `writeSessionThroughLoader` (load-recording.ts, pulled out of
// `loadOneSession` for this) for the write path — ADR-0009: "a fetched race
// reaches the exporter the same way a loaded one does" — so the ADR-0010
// live guard, the upcoming -> events -> finished ordering, and idempotency
// (`event.createMany({ skipDuplicates: true })`) are exactly the loader's,
// not reimplemented. Auth (`openf1/auth.ts`), the `LiveNormalizer`
// (`openf1/normalize.ts`), and `RECORDING_ENDPOINT_ORDER` (load-recording.ts)
// are reused unchanged too.
//
// What's new here, specific to fetching straight from the API rather than
// reading a recorded capture:
//   - a rate-limited, retrying `Fetcher` (`withSpacing`, `withRetry` below)
//     — the loader reads a file, so it never needed either;
//   - the emission-order rule (`orderForEmission`): historical rows carry no
//     `received_at` (the loader's ordering signal), so this orders by
//     `source_time` instead, with the lap/stint exceptions reproduced on
//     `orderKeyMs` below;
//   - the fetched `drivers` rows ARE this session's entry list (unlike the
//     loader and the live rest lane, which both emit the static
//     `ENTRY_LIST_2026`) — never emit `ENTRY_LIST_2026` for a fetched race;
//   - the raw response for every endpoint is also appended to a jsonl
//     recording (`openf1/recorder.ts`, unchanged) under
//     `LIVE_LOG_DIR/<session_key>/raw/<endpoint>.jsonl`, so the loader can
//     replay this session later without OpenF1.
//
// Usage: `DATABASE_URL=... [OPENF1_LOGIN=... OPENF1_PASSWORD=...] pnpm
// ingest:fetch-race <session_key> [<session_key> ...]` (package.json script
// "fetch-race"; root script "ingest:fetch-race").

import { createDb } from "@formula-time/db";

import { loadConfig } from "./config.js";
import { RECORDING_ENDPOINT_ORDER, writeSessionThroughLoader } from "./load-recording.js";
import type { LoaderDb } from "./load-recording.js";
import { OpenF1Auth, createOpenF1Fetcher, credentialsFromEnv } from "./openf1/auth.js";
import { LiveNormalizer, eventId, timestampMillis, timestampValue } from "./openf1/normalize.js";
import type { NormalizedRow } from "./openf1/normalize.js";
import { FETCH_SPACING_MS, MAX_RETRIES, RETRY_DELAY_MS, withRetry, withSpacing } from "./openf1/rate-limit.js";
import type { RetryOptions, Sleep } from "./openf1/rate-limit.js";
import { JsonlRecorder } from "./openf1/recorder.js";
import { OPENF1_BASE } from "./openf1/rest-lane.js";
import type { Fetcher, QueueItem, RawRecord } from "./openf1/types.js";
import { EventQueue } from "./writer/queue.js";
import type { DrainResult } from "./writer/writer.js";
import { EventWriter } from "./writer/writer.js";

// The spacing/retry wrapper lives in `openf1/rate-limit.ts` — shared with
// `load-recording.ts`'s network fallback for a meetings lookup — so both
// obey the same request budget against the live API. Re-exported here
// because this module is where callers (and existing tests) already look
// for it.
export { FETCH_SPACING_MS, MAX_RETRIES, RETRY_DELAY_MS, withRetry, withSpacing };
export type { RetryOptions, Sleep };

/**
 * The lap rule: historical laps arrive complete; applied at `date_start`
 * they would reveal a lap's final time at the start of the lap. Apply a lap
 * at `date_start + lap_duration` (seconds) when `lap_duration` is present,
 * else at `date_start`.
 *
 * This adjusted time is used for BOTH the emission order key
 * (`orderKeyMs` below) AND the row's persisted `source_time`, not only the
 * order key. A live capture emits a laps row more than once as it fills in
 * over the lap (the normalizer's unadjusted `date_start` reflects that: the
 * row a viewer sees mid-lap really does only have partial data). A
 * historical fetch instead gets one already-complete row per lap;
 * `splitLapRow` below turns that one row into the same two versions a live
 * capture would have produced — a start row (durations/segments nulled,
 * `lap_duration` absent so this function leaves it at raw `date_start`) and
 * the complete row (unchanged, adjusted here). Storing the complete row's
 * `source_time` as the unadjusted `date_start` would let the browser fold's
 * scrub (`foldAt`/`truncationBoundary` in apps/web, which walks `seq` order
 * and stops at the first event whose OWN `source_time` exceeds the scrub
 * target) include the lap's final time/sectors for any scrub target between
 * the lap's start and its true finish — exactly the spoiler this adjustment
 * exists to prevent. So the complete row's stored `source_time` must be the
 * same adjusted instant as its order key, not the raw `date_start` the
 * `LiveNormalizer` computes for every other purpose.
 */
export function lapsEffectiveSourceTimeIso(row: NormalizedRow): string | null {
  if (row.endpoint !== "laps") return row.sourceTime;
  const dateStart = timestampMillis(timestampValue(row.payload["date_start"]));
  if (dateStart === null) return row.sourceTime;
  const lapDuration = row.payload["lap_duration"];
  const ms = typeof lapDuration === "number" ? dateStart + lapDuration * 1000 : dateStart;
  return new Date(ms).toISOString();
}

// Fields still null in the earliest version the live recorder captures of a
// lap row — measured against `recordings/11361/raw/laps.jsonl` (driver 44,
// lap 5: `date_start` set, every field below null, nothing else populated
// yet). A historical fetch gets one already-complete row per lap; splitting
// it reproduces that same two-version shape so the counter, the lap marker
// and the poll clock flip at lap start rather than at lap end.
const LAP_START_NULL_FIELDS = [
  "lap_duration",
  "duration_sector_1",
  "duration_sector_2",
  "duration_sector_3",
  "i1_speed",
  "i2_speed",
  "st_speed",
  "segments_sector_1",
  "segments_sector_2",
  "segments_sector_3",
] as const;

/**
 * Splits one historical laps row into the two the live lane records: a
 * start row (this same payload with the fields above nulled, so it carries
 * only what's known when the lap begins) and the complete row (the payload
 * unchanged). The two payloads differ, so `eventId` differs too — both
 * survive `createMany({ skipDuplicates })`.
 *
 * A row missing `date_start` or `lap_duration` cannot be split — the caller
 * still has only the complete-row shape to emit, same as before this
 * function existed.
 */
export function splitLapRow(row: NormalizedRow): NormalizedRow[] {
  if (row.endpoint !== "laps") return [row];
  const dateStart = timestampValue(row.payload["date_start"]);
  const lapDuration = row.payload["lap_duration"];
  if (dateStart === null || typeof lapDuration !== "number") return [row];

  const startPayload: RawRecord = { ...row.payload };
  for (const field of LAP_START_NULL_FIELDS) startPayload[field] = null;

  const startRow: NormalizedRow = {
    eventId: eventId("laps", startPayload),
    endpoint: "laps",
    sourceTime: dateStart,
    payload: startPayload,
  };
  return [startRow, row];
}

/**
 * The order-key rule: the lap exception is `lapsEffectiveSourceTimeIso`
 * above (shared with the persisted `source_time`, see its comment); the
 * stint exception is: `stints` rows have no timestamp, so place each at
 * the `date_start` of its `lap_start` lap (join on `driver_number` + lap
 * number), else at session start.
 *
 * Every other endpoint already carries a real timestamp field
 * (`endpointConfigs` in normalize.ts), computed into `row.sourceTime` by the
 * `LiveNormalizer` that ran over every endpoint in fetch order — including
 * `stints`, whose join (`lapStartByDriverAndLap`) is populated as a side
 * effect of normalizing `laps`, which fetch order always visits first. So
 * `row.sourceTime` already IS the stint rule's answer for `stints`.
 */
function orderKeyMs(row: NormalizedRow, sessionStartMs: number): number {
  return timestampMillis(lapsEffectiveSourceTimeIso(row)) ?? sessionStartMs;
}

/**
 * Orders every non-`drivers` row for emission — this ordering decides
 * `seq`, so it is the replay order — and puts `drivers` first, unsorted:
 * the fetched `drivers` rows ARE this session's entry list, and drivers
 * rows come first as a hard requirement, not a consequence of their
 * (nonexistent) timestamp.
 *
 * `byEndpoint` must already be in `RECORDING_ENDPOINT_ORDER`'s iteration
 * order (the caller builds it that way, by fetching in that order) — the
 * `rest` array below is built in that same order before the sort, so a
 * stable sort (`Array.prototype.sort`, ES2019+) leaves rows that tie on
 * `orderKeyMs` in fetch order: ties break in the fetch order above.
 */
export function orderForEmission(
  byEndpoint: ReadonlyMap<string, readonly NormalizedRow[]>,
  sessionStartMs: number,
): NormalizedRow[] {
  const drivers = byEndpoint.get("drivers") ?? [];
  const rest: NormalizedRow[] = [];
  for (const endpoint of RECORDING_ENDPOINT_ORDER) {
    if (endpoint === "drivers") continue;
    for (const row of byEndpoint.get(endpoint) ?? []) rest.push(row);
  }
  rest.sort((a, b) => orderKeyMs(a, sessionStartMs) - orderKeyMs(b, sessionStartMs));
  return [...drivers, ...rest];
}

/**
 * Pushes already-normalized rows straight onto the queue — the second half
 * of `emitRows` (rest-lane.ts), without its normalize call, since every row
 * here was normalized once already, up front, in fetch order (see the
 * module comment on `orderForEmission`). Calling `LiveNormalizer.normalize`
 * a second time on the same rows would find them all already `seen` and
 * drop them.
 *
 * Uses `lapsEffectiveSourceTimeIso`, not `row.sourceTime` directly, so a
 * laps row's *stored* `source_time` is the same adjusted instant as the
 * order key that placed it — see that function's comment for why.
 */
function pushNormalized(queue: EventQueue<QueueItem>, sessionKey: number, rows: readonly NormalizedRow[]): void {
  if (rows.length === 0) return;
  const items: QueueItem[] = rows.map((row) => {
    const sourceTime = lapsEffectiveSourceTimeIso(row);
    return {
      eventId: row.eventId,
      sessionKey: BigInt(sessionKey),
      endpoint: row.endpoint,
      sourceTime: sourceTime ? new Date(sourceTime) : null,
      payload: row.payload,
    };
  });
  queue.pushAll(items);
}

/** The recorder seam (`openf1/recorder.ts`'s `JsonlRecorder` shape) — a fake in the unit test, the real thing in production. */
export interface RaceRecorder {
  writeSession(session: RawRecord, sessionKey: number): Promise<void>;
  appendRows(sessionKey: number, endpoint: string, rows: RawRecord[]): Promise<void>;
}

export const NULL_RECORDER: RaceRecorder = {
  async writeSession() {},
  async appendRows() {},
};

export interface FetchOneSessionResult {
  /** `false` when `GET sessions?session_key=` returned no row — refuse with exit 1 if none. */
  found: boolean;
  skipped: boolean;
  drainResult: DrainResult;
}

/**
 * Fetches and writes one session: `GET sessions?session_key=<k>`, the
 * ADR-0010 guard (via `writeSessionThroughLoader`), then — only once the
 * guard has passed, so a refused/live session costs no further requests —
 * every `RECORDING_ENDPOINT_ORDER` endpoint, normalized in fetch order
 * into `byEndpoint`, recorded to jsonl as it goes, then pushed to the
 * queue in `orderForEmission`'s order, grouped into consecutive
 * same-endpoint batches the same shape `loadOneSession`'s merged loop
 * uses.
 */
async function fetchOneSession(
  sessionKey: number,
  fetcher: Fetcher,
  db: LoaderDb,
  writer: EventWriter,
  queue: EventQueue<QueueItem>,
  recorder: RaceRecorder,
  now: () => number,
  log: (line: string) => void,
  replace: boolean,
): Promise<FetchOneSessionResult> {
  const noEvents: DrainResult = { inserted: 0, skipped: 0 };
  const sessionsRaw = await fetcher(`${OPENF1_BASE}/sessions?session_key=${sessionKey}`);
  const sessions = Array.isArray(sessionsRaw) ? (sessionsRaw as RawRecord[]) : [];
  const session = sessions[0];
  if (!session) {
    log(`fetch-race: refused ${sessionKey}: no session found for this session_key`);
    return { found: false, skipped: true, drainResult: noEvents };
  }

  const nowMs = now();
  const parsedStart = Date.parse(String(session["date_start"] ?? ""));
  const sessionStartMs = Number.isNaN(parsedStart) ? nowMs : parsedStart;

  // `meetings?meeting_key=` — the session row never carries the Grand Prix
  // name itself (`sessionFieldsFromRaw`'s doc comment). Fetched lazily,
  // inside `getMeetingNames` below, so it only ever runs once
  // `writeSessionThroughLoader`'s own guards (still-live, non-race, window
  // not closed) have already passed — a refused session must cost no
  // further request. `meetingRow` is captured in this closure's outer
  // scope so `emitAll` below (which runs after `getMeetingNames`, also
  // past the guards) can record it to jsonl too.
  const meetingKey = Number(session["meeting_key"]);
  let meetingRow: RawRecord | undefined;
  const getMeetingNames = async (): Promise<ReadonlyMap<number, string>> => {
    if (!Number.isFinite(meetingKey)) return new Map();
    try {
      const raw = await fetcher(`${OPENF1_BASE}/meetings?meeting_key=${meetingKey}`);
      const rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
      meetingRow = rows.find((row) => Number(row["meeting_key"]) === meetingKey);
      const name = meetingRow?.["meeting_name"];
      return typeof name === "string" && name.length > 0 ? new Map([[meetingKey, name]]) : new Map();
    } catch (error) {
      log(`fetch-race: meetings fetch failed for meeting_key=${meetingKey}: ${error instanceof Error ? error.message : String(error)}`);
      return new Map();
    }
  };

  const result = await writeSessionThroughLoader(
    session,
    db,
    writer,
    queue,
    nowMs,
    log,
    getMeetingNames,
    async (normalizer: LiveNormalizer, sessionKeyNum: number, alreadyFinished: boolean) => {
      // Fetching and normalizing always happens on a
      // rerun (DB-level idempotency comes from `event.createMany({
      // skipDuplicates: true })` downstream), but a fresh `LiveNormalizer`
      // per call means every row looks "new" to it again — recording those
      // "new" rows to the jsonl file on every rerun would duplicate its
      // content unboundedly, unlike the DB write. Only record when this run
      // is doing real (first) work for the session.
      const shouldRecord = !alreadyFinished;
      if (shouldRecord) await recorder.writeSession(session, sessionKeyNum);
      if (shouldRecord && meetingRow) await recorder.appendRows(sessionKeyNum, "meetings", [meetingRow]);

      const byEndpoint = new Map<string, NormalizedRow[]>();
      for (const endpoint of RECORDING_ENDPOINT_ORDER) {
        const raw = await fetcher(`${OPENF1_BASE}/${endpoint}?session_key=${sessionKeyNum}`);
        const rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
        const { rows: normalized } = normalizer.normalize(endpoint, rows);
        // Split for emission only — the jsonl recording below still records
        // one raw OpenF1 row per lap, the response actually received.
        const emitted = endpoint === "laps" ? normalized.flatMap(splitLapRow) : normalized;
        byEndpoint.set(endpoint, emitted);
        // `new` is what the normalizer saw (and what the recording gets);
        // `emitted` is what actually reaches the queue — the two diverge
        // once a laps row splits into a start row and a complete row.
        log(
          `fetch-race: session=${sessionKeyNum} endpoint=${endpoint} rows=${rows.length} new=${normalized.length} emitted=${emitted.length}`,
        );
        if (shouldRecord && normalized.length > 0) {
          await recorder.appendRows(sessionKeyNum, endpoint, normalized.map((row) => row.payload));
        }
      }

      const ordered = orderForEmission(byEndpoint, sessionStartMs);
      let i = 0;
      while (i < ordered.length) {
        const endpoint = ordered[i]!.endpoint;
        const group: NormalizedRow[] = [];
        while (i < ordered.length && ordered[i]!.endpoint === endpoint) {
          group.push(ordered[i]!);
          i += 1;
        }
        pushNormalized(queue, sessionKeyNum, group);
      }
    },
    { replace },
  );

  return { found: true, ...result };
}

export interface FetchRacesOptions {
  now?: () => number;
  onLog?: (line: string) => void;
  recorder?: RaceRecorder;
  /** Same `--replace` as the recording loader (load-recording.ts): reload this session's events in place. */
  replace?: boolean;
}

export interface FetchRacesResult {
  inserted: number;
  skipped: number;
  sessionsAttempted: number;
  /** Refused (ADR-0010 live guard) or left unfinished by a writer failure — same meaning as `LoadRecordingsResult.sessionsSkipped`. */
  sessionsSkipped: number;
  /** `GET sessions?session_key=` returned no row: refuse with exit 1 if none. */
  sessionsNotFound: number;
}

/**
 * Fetches and writes one or more sessions by `session_key`, sharing one
 * `EventQueue`/`EventWriter` across all of them (same shape as
 * `loadRecordings`).
 */
export async function fetchRaces(
  sessionKeys: number[],
  db: LoaderDb,
  fetcher: Fetcher,
  opts: FetchRacesOptions = {},
): Promise<FetchRacesResult> {
  const now = opts.now ?? Date.now;
  const log = opts.onLog ?? ((line: string) => console.log(line));
  const recorder = opts.recorder ?? NULL_RECORDER;
  const replace = opts.replace ?? false;

  const queue = new EventQueue<QueueItem>();
  const writer = new EventWriter(db, queue, { log });

  let sessionsAttempted = 0;
  let sessionsSkipped = 0;
  let sessionsNotFound = 0;
  let totals: DrainResult = { inserted: 0, skipped: 0 };

  const fold = (result: DrainResult): void => {
    totals = { inserted: totals.inserted + result.inserted, skipped: totals.skipped + result.skipped };
  };

  for (const sessionKey of sessionKeys) {
    sessionsAttempted += 1;
    try {
      const result = await fetchOneSession(sessionKey, fetcher, db, writer, queue, recorder, now, log, replace);
      fold(result.drainResult);
      if (!result.found) sessionsNotFound += 1;
      else if (result.skipped) sessionsSkipped += 1;
    } catch (error) {
      sessionsSkipped += 1;
      log(`fetch-race: session skipped ${sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Same reasoning as loadRecordings: whatever made it onto the queue
      // before a mid-session throw must still reach the writer.
      fold(await writer.drainAll());
    }
  }

  log(
    `fetch-race: summary inserted=${totals.inserted} skipped=${totals.skipped} skipped_sessions=${sessionsSkipped} not_found=${sessionsNotFound}`,
  );
  return { ...totals, sessionsAttempted, sessionsSkipped, sessionsNotFound };
}

// CLI entry: `node dist/fetch-race.js [--replace] <session_key>
// [<session_key> ...]` (package.json script "fetch-race"; root script
// "ingest:fetch-race"). Guarded so this module can be imported by the unit
// test without running the CLI.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const replace = argv.includes("--replace");
  const args = argv.filter((arg) => arg !== "--replace");
  if (args.length === 0) {
    console.error("fetch-race: usage: pnpm ingest:fetch-race [--replace] <session_key> [<session_key> ...]");
    process.exit(1);
  }
  const sessionKeys: number[] = [];
  for (const arg of args) {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`fetch-race: invalid session_key: ${arg}`);
      process.exit(1);
    }
    sessionKeys.push(n);
  }

  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("fetch-race: DATABASE_URL is not set; refusing to start (ADR-0004 config seam).");
    process.exit(1);
  }

  const db = createDb(config.databaseUrl, { max: 1 });

  // Auth as the REST lane does — OPENF1_LOGIN/PASSWORD when
  // set, unauthenticated otherwise (works for historical data outside live
  // windows; apps/ingest/AGENTS.md).
  const auth = new OpenF1Auth(credentialsFromEnv());
  const authenticated = createOpenF1Fetcher(auth);
  const retried = withRetry(authenticated);
  const fetcher = withSpacing(retried, FETCH_SPACING_MS);
  const recorder = new JsonlRecorder(config.liveLogDir);

  fetchRaces(sessionKeys, db, fetcher, { recorder, replace })
    .then(async (result) => {
      await db.$disconnect();
      // Same "exit 1 only if every attempted session failed" rule
      // load-recording.ts uses — a partial run (some sessions fetched, some
      // not found/refused) still wrote what it could.
      const allFailed =
        result.sessionsAttempted > 0 &&
        result.sessionsSkipped + result.sessionsNotFound === result.sessionsAttempted;
      process.exit(allFailed ? 1 : 0);
    })
    .catch(async (error: unknown) => {
      console.error(`fetch-race: failed: ${error instanceof Error ? error.message : String(error)}`);
      await db.$disconnect();
      process.exit(1);
    });
}
