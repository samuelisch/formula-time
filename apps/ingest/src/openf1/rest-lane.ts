// The REST lane. Lifted from
// `../f1-live-events-poc/poc/ts/live_capture.ts` (`OPENF1_BASE`,
// `POLL_ROTATION`, `pickLiveSession`, `sessionExpired`, `buildPollUrl`,
// `Fetcher`, the polling-loop shape) and
// `../f1-live-events-poc/poc/live-recorder/recorder.ts` (discovery, the
// "poll the full endpoint every time, dedup by eventId" cadence — the live
// API rejects every date filter; apps/ingest/AGENTS.md). Does NOT lift
// `LiveRace` / `state_authority` / `session_registry`: ingest never folds.

import { ENTRY_LIST_2026 } from "./entry-list.js";
import { LiveNormalizer, endpointConfigs } from "./normalize.js";
import type { Fetcher, QueueItem, RawRecord } from "./types.js";
import type { EventQueue } from "../writer/queue.js";
import { isRaceSession } from "../writer/sessions.js";

export const OPENF1_BASE = "https://api.openf1.org/v1";

// OpenF1 serves live data from 30 minutes before `date_start` to 30 minutes
// after `date_end`.
const LIVE_WINDOW_MS = 30 * 60 * 1000;

// Weighted rotation: hot endpoints appear most often. 21 slots; at a 2.2s
// tick a full cycle ~46s (~27 req/min) — "REST (cadence unchanged from the
// POC, the safety net)" (apps/ingest/AGENTS.md).
export const POLL_ROTATION: string[] = [
  "position", "intervals", "laps", "race_control",
  "position", "intervals", "weather",
  "position", "intervals", "pit",
  "position", "intervals", "laps", "race_control",
  "position", "intervals", "stints",
  "position", "intervals", "position", "intervals",
];

export function pickLiveSession(sessions: RawRecord[], nowMs: number): RawRecord | null {
  for (const session of sessions) {
    const start = Date.parse(String(session["date_start"] ?? ""));
    const end = Date.parse(String(session["date_end"] ?? ""));
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (nowMs >= start - LIVE_WINDOW_MS && nowMs <= end + LIVE_WINDOW_MS) {
      return session;
    }
  }
  return null;
}

// A session stops being live once the clock leaves its window (same ±30min
// grace as discovery). Pure so it can be unit-tested without clock injection.
export function sessionExpired(session: RawRecord | null, nowMs: number): boolean {
  if (session === null) return false;
  const end = Date.parse(String(session["date_end"] ?? ""));
  if (Number.isNaN(end)) return false;
  return nowMs > end + LIVE_WINDOW_MS;
}

// The live API rejects every date filter (apps/ingest/AGENTS.md); the rest
// lane always calls this with `cursor: null` and relies on the normalizer's
// per-endpoint dedup + `event.createMany({ skipDuplicates: true })` instead.
// The cursor parameter is kept (lifted from the POC signature) because a
// future incremental source could still use it.
export function buildPollUrl(endpoint: string, sessionKey: number, cursor: string | null): string {
  const field = endpointConfigs[endpoint]?.timestampField;
  const params = new URLSearchParams({ session_key: String(sessionKey) });
  if (field && cursor) params.set(`${field}>=`, cursor);
  return `${OPENF1_BASE}/${endpoint}?${params.toString()}`;
}

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OpenF1 ${response.status} for ${url}`);
  return response.json();
};

export interface EmitRowsResult {
  newRows: number;
  malformed: number;
  /** The normalized (already-deduped-against-`normalizer`) payloads, for a caller that also records them (e.g. the jsonl recorder's `onNewRows`). */
  payloads: RawRecord[];
}

/**
 * The one normalize-and-enqueue path — so the ids match a live run —
 * pushed out of `RestLane` so the one-shot
 * recording loader (`load-recording.ts`) can drive the same normalizer +
 * queue a live session does, both for the static `ENTRY_LIST_2026`
 * `drivers` emission and for every `raw/*.jsonl` endpoint. `RestLane`
 * itself calls this too (see `emitAndRecord` below) — no second
 * normalize path.
 */
export function emitRows(
  normalizer: LiveNormalizer,
  queue: EventQueue<QueueItem>,
  endpoint: string,
  sessionKey: number,
  rows: RawRecord[],
): EmitRowsResult {
  if (rows.length === 0) return { newRows: 0, malformed: 0, payloads: [] };
  const { rows: normalized, malformed } = normalizer.normalize(endpoint, rows);
  if (normalized.length === 0) return { newRows: 0, malformed, payloads: [] };
  const items: QueueItem[] = normalized.map((n) => ({
    eventId: n.eventId,
    sessionKey: BigInt(sessionKey),
    endpoint,
    sourceTime: n.sourceTime ? new Date(n.sourceTime) : null,
    payload: n.payload,
  }));
  queue.pushAll(items);
  return { newRows: normalized.length, malformed, payloads: normalized.map((n) => n.payload) };
}

export interface EmitTaggedRowsResult {
  newRows: number;
  malformed: number;
  /** Rows whose OWN `session_key` differs from `expectedSessionKey` — still written, tagged to the session they name, and counted as `foreign`. `null` `expectedSessionKey` (the Friday meeting-wide fetch has no single session to compare against) counts nothing as foreign. */
  foreign: number;
  /** Rows naming a `session_key` that is not in the `sessions` table (per `isKnownSession`): dropped, never queued. `events.session_key` is a real FK, and one such row would fail the writer's whole batch and requeue it forever. */
  unknownSession: number;
  payloads: RawRecord[];
  /** The written payloads per session_key, so a caller can feed the jsonl recorder once per session. */
  groups: Array<{ sessionKey: number; payloads: RawRecord[] }>;
}

/**
 * Tags each `drivers` row to the `session_key` IN ITS OWN PAYLOAD, never to
 * the session or meeting the fetch was made for. Verified from
 * `recordings/11361/raw/drivers.jsonl`: every OpenF1 `drivers`
 * row carries its own `session_key` and `meeting_key` fields, e.g.
 * `{"meeting_key":1293,"session_key":11361,"driver_number":1,...}` — so the
 * tagging rule is: a drivers row is tagged to the `session_key` in its own
 * payload. Rows are grouped by that own key and each group runs through the
 * normal `emitRows` path (endpoint `drivers`), so dedup/malformed handling
 * stay identical to every other endpoint. A row with no numeric
 * `session_key` of its own can't be tagged or written; it's counted as
 * malformed, same meaning `emitRows`/`LiveNormalizer.normalize` give that
 * word elsewhere. A row naming a session that `isKnownSession` rejects (not
 * in the `sessions` table) is dropped and counted `unknownSession`: the FK
 * on `events.session_key` would fail the writer's whole batch, and the
 * writer requeues a failed batch at the front forever.
 */
export function emitTaggedDriverRows(
  normalizer: LiveNormalizer,
  queue: EventQueue<QueueItem>,
  rows: RawRecord[],
  expectedSessionKey: number | null,
  isKnownSession: (sessionKey: number) => boolean = () => true,
): EmitTaggedRowsResult {
  const byKey = new Map<number, RawRecord[]>();
  let foreign = 0;
  let malformed = 0;
  let unknownSession = 0;
  for (const row of rows) {
    const key = Number(row["session_key"]);
    if (!Number.isFinite(key)) {
      malformed += 1;
      continue;
    }
    if (!isKnownSession(key)) {
      unknownSession += 1;
      continue;
    }
    if (expectedSessionKey !== null && key !== expectedSessionKey) foreign += 1;
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  let newRows = 0;
  const payloads: RawRecord[] = [];
  const groups: EmitTaggedRowsResult["groups"] = [];
  for (const [key, groupRows] of byKey) {
    const result = emitRows(normalizer, queue, "drivers", key, groupRows);
    newRows += result.newRows;
    malformed += result.malformed;
    payloads.push(...result.payloads);
    if (result.payloads.length > 0) groups.push({ sessionKey: key, payloads: result.payloads });
  }
  return { newRows, malformed, foreign, unknownSession, payloads, groups };
}

export interface RestLaneOptions {
  fetcher?: Fetcher;
  year?: number;
  now?: () => number;
  /** Rotation cadence once a session is live. Default matches the POC: 2200ms. */
  tickMs?: number;
  /** Discovery cadence while no session is in its window. Default: every 60 s. */
  discoveryIntervalMs?: number;
  /** Sessions upsert — called for every session row discovery sees. */
  onSession?: (session: RawRecord, nowMs: number) => void | Promise<void>;
  /**
   * Called once, when a session is newly selected as the one being followed
   * (`this.sessionKey` changes) — NOT on every discovery tick like
   * `onSession`. This is where a per-session, one-time side effect (writing
   * the jsonl recorder's `session.json`) belongs, so it doesn't re-run every
   * 60s while nothing is live.
   */
  onSessionSelected?: (session: RawRecord, nowMs: number) => void | Promise<void>;
  /** New (already-deduped) rows for one endpoint — feeds the jsonl recorder. */
  onNewRows?: (sessionKey: number, endpoint: string, rows: RawRecord[]) => void | Promise<void>;
  onLog?: (line: string) => void;
}

export interface PollResult {
  endpoint: string;
  rows: number;
  newRows: number;
  malformed: number;
}

export class RestLane {
  private readonly fetcher: Fetcher;
  private readonly year: number;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly onSession: RestLaneOptions["onSession"];
  private readonly onSessionSelected: RestLaneOptions["onSessionSelected"];
  private readonly onNewRows: RestLaneOptions["onNewRows"];
  private readonly log: (line: string) => void;

  private normalizer = new LiveNormalizer();
  private session: RawRecord | null = null;
  private sessionKey: number | null = null;
  private rotationIndex = 0;

  // Entry list. All state below is reset in ensureLiveSession()
  // when a NEW session is selected (`this.sessionKey` changes) — never on
  // every discovery tick, same reasoning as onSessionSelected.
  //
  // Session selection: retried from the poll loop every 5
  // minutes until the fetch returns >= 1 row.
  private entryListSessionKey: number | null = null;
  private entryListSatisfied = false;
  private entryListFallbackEmitted = false;
  private entryListNextRetryAt = 0;
  // Pre-race refresh: a one-shot per session_key; a throw
  // leaves it unmarked so the very next tick retries it.
  private readonly preRaceRefreshDone = new Set<number>();
  // Friday, per meeting_key: retried every 30 minutes while it
  // returns zero rows or fails.
  private readonly fridayMeetings = new Map<number, { satisfied: boolean; nextRetryAt: number }>();
  // The last `sessions?year=` snapshot discovery saw — Friday's condition
  // ("a meeting whose first session's date_start has passed and whose race
  // session is in the sessions table") needs the whole year's sessions, not
  // just the one currently selected, and discoverOnce() stops running once a
  // session is live, so pollOnce() reuses this snapshot instead of refetching.
  private lastSessions: RawRecord[] = [];
  // Every session_key whose `sessions` upsert has succeeded at least once
  // (this process). A drivers row tagged to any other key must not be
  // queued: `events.session_key` is a FK, one such row fails the writer's
  // whole batch, and the writer requeues that batch at the front forever.
  private readonly knownSessionKeys = new Set<number>();
  // While a session is live the idle discovery loop does not run, so the
  // sessions snapshot (and knownSessionKeys) would freeze: a race session
  // whose upsert had not landed before FP1 went live would never become
  // known and Friday's 30-minute retry would never fire. pollOnce() refreshes
  // the snapshot every discoveryIntervalMs instead, as its own tick.
  private nextSessionsRefreshAt = 0;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  // Tracks the tick currently awaiting the network so `stop()` can wait for
  // it instead of returning while a `pollOnce`/`discoverOnce` is still
  // in-flight — otherwise it enqueues rows after the writer has already
  // drained and the process has exited (SIGTERM race).
  private currentTick: Promise<void> | null = null;

  public constructor(
    private readonly queue: EventQueue<QueueItem>,
    opts: RestLaneOptions = {},
  ) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.year = opts.year ?? new Date().getUTCFullYear();
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 2200;
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 60_000;
    this.onSession = opts.onSession;
    this.onSessionSelected = opts.onSessionSelected;
    this.onNewRows = opts.onNewRows;
    this.log = opts.onLog ?? ((): void => {});
  }

  public status(): { active: boolean; sessionKey: number | null } {
    return { active: this.sessionKey !== null, sessionKey: this.sessionKey };
  }

  /**
   * The REST lane's current normalizer instance (MQTT lane): each
   * message goes through the shared LiveNormalizer with the CURRENT session
   * key from the REST lane's selection — REST is the authority on
   * which session is live, so MQTT rides the SAME normalizer instance rather
   * than keeping its own dedup state, and it's swapped out from under the
   * caller exactly when REST's is: on `ensureLiveSession`'s new-session reset.
   */
  public getNormalizer(): LiveNormalizer {
    return this.normalizer;
  }

  /**
   * `sessions?year=<current>`, every 60 s until a session is inside
   * its ±30 min window. Upserts every session it sees, and selects the
   * live session (if any) for the rotation.
   */
  public async discoverOnce(): Promise<{ sessionCount: number; live: boolean }> {
    const nowMs = this.now();
    const refreshed = await this.refreshSessions(nowMs);
    if (refreshed === null) return { sessionCount: 0, live: this.sessionKey !== null };
    const { rows, upserted } = refreshed;

    // The one-drivers-fetch-per-tick rule holds here too: a session
    // discovered inside its live window fetches its entry list at selection,
    // and Friday's meeting-wide fetch then waits for the next tick.
    const selectionFetched = await this.ensureLiveSession(rows, nowMs, upserted);

    // Friday: checked on every discovery tick — this is the idle (60s)
    // loop's own extra fetch, not competing with the rotation budget (there
    // is no rotation while idle).
    if (!selectionFetched) await this.checkFridayFetch(this.lastSessions, nowMs);

    return { sessionCount: rows.length, live: this.sessionKey !== null };
  }

  /**
   * `sessions?year=` plus the upsert of every race row: refreshes
   * `lastSessions` (every row this fetch returned, race or not) and
   * `knownSessionKeys` (race rows whose upsert succeeded only). Shared by
   * the idle discovery tick and the live loop's periodic refresh. `null`
   * when the fetch failed or returned no array.
   */
  private async refreshSessions(nowMs: number): Promise<{ rows: RawRecord[]; upserted: Set<RawRecord> } | null> {
    this.nextSessionsRefreshAt = nowMs + this.discoveryIntervalMs;
    let sessions: unknown;
    try {
      sessions = await this.fetcher(`${OPENF1_BASE}/sessions?year=${this.year}`);
    } catch (error) {
      this.log(`rest: session discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!Array.isArray(sessions)) return null;
    const rows = sessions as RawRecord[];

    // Only race sessions are captured (isRaceSession): a practice,
    // qualifying or sprint row is never upserted, never added to
    // `upserted`, and never added to `knownSessionKeys` — so
    // ensureLiveSession() can't select it and a drivers row tagged to it is
    // dropped downstream as unknownSession.
    //
    // Tracks which rows' onSession (the sessions upsert) succeeded THIS
    // tick, so ensureLiveSession() never selects a session whose row failed
    // to write — selecting it anyway would mean every later event insert
    // fails its FK against a `sessions` row that was never created.
    const upserted = new Set<RawRecord>();
    for (const row of rows) {
      if (!isRaceSession(row)) continue;
      try {
        await this.onSession?.(row, nowMs);
        upserted.add(row);
        const key = Number(row["session_key"]);
        if (Number.isFinite(key)) this.knownSessionKeys.add(key);
      } catch (error) {
        // One malformed row (bad session_key, bad date) must not throw out
        // of this loop and starve ensureLiveSession()/the Friday entry-list
        // check every discovery tick — sessions.ts's upsertSession is what
        // actually validates and throws; this is where ingest survives it.
        this.log(`rest: session row skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Every row this fetch returned, race or not: the Friday entry-list
    // check groups a meeting's sessions from this snapshot to find its
    // first session's start and its race session, independent of whether a
    // session's own `sessions` upsert has landed — checkFridayFetch below
    // still requires the race session to be in `knownSessionKeys` before it
    // fires, so a not-yet-written race session still blocks the fetch the
    // same way it always did.
    this.lastSessions = rows;
    return { rows, upserted };
  }

  /** Returns whether it made a drivers fetch this tick (the selection fetch). */
  private async ensureLiveSession(
    sessions: RawRecord[],
    nowMs: number,
    upserted: Set<RawRecord>,
  ): Promise<boolean> {
    const live = pickLiveSession(sessions, nowMs);
    if (!live) return false;
    if (!isRaceSession(live)) {
      // Only race sessions are captured: a practice or qualifying session
      // inside its live window is left unselected, so the REST rotation
      // never polls it. Not an error — this is the common case whenever a
      // practice/quali session is the only one currently in its window.
      return false;
    }
    if (!upserted.has(live)) {
      // Its sessions upsert failed this tick (thrown, caught, and logged
      // above) — selecting it anyway would mean every later event insert
      // fails its FK forever against a `sessions` row that doesn't exist.
      // Leave sessionKey null; the next discoverOnce() retries the upsert.
      this.log("rest: session not selected: upsert failed");
      return false;
    }
    const key = Number(live["session_key"]);
    if (!Number.isFinite(key)) return false;
    if (this.sessionKey !== key) {
      this.session = live;
      this.sessionKey = key;
      this.normalizer = new LiveNormalizer();
      this.rotationIndex = 0;
      this.log(
        `rest: following session_key=${key} (${String(live["country_name"] ?? "?")})`,
      );
      // Once per newly-selected session — NOT on every discovery tick like
      // onSession: recorder.writeSession() running from onSession would
      // re-stamp session.json for every session of the year every 60s while
      // nothing is live.
      await this.onSessionSelected?.(live, nowMs);

      // Fetch `drivers?session_key=<selected>` for
      // the newly-selected session. `entryListNextRetryAt = nowMs` makes the
      // first attempt immediate; tryEntryListSelectionFetch() falls back to
      // the static ENTRY_LIST_2026 and schedules a 5-minute retry if the
      // fetch fails or returns zero rows (a restart re-running this is
      // harmless: the payload's own `session_key`
      // makes the event id unique per session, and event.createMany's
      // skipDuplicates drops the repeat).
      this.entryListSessionKey = key;
      this.entryListSatisfied = false;
      this.entryListFallbackEmitted = false;
      this.entryListNextRetryAt = nowMs;
      return this.tryEntryListSelectionFetch(nowMs);
    }
    return false;
  }

  /**
   * Fetches `drivers?session_key=<selected>`, tags each row by its
   * own `session_key` (emitTaggedDriverRows), asserting it equals the
   * selected key (a mismatch is still written, tagged to the session it
   * names, and counted `foreign` — never dropped). Zero rows or a failure:
   * emit the static ENTRY_LIST_2026 fallback once ("entry list: static
   * fallback (<reason>)"), then keep retrying every 5 minutes — from the
   * poll loop (pollOnce -> runDueDriversFetch), not only at selection —
   * until the fetch returns >= 1 row, at which point those rows are emitted
   * too (the writer's dedup makes the overlap with the fallback harmless).
   * Returns `true` whenever it made an attempt this tick (used by pollOnce
   * to charge the tick's one-drivers-fetch budget), `false` when nothing was
   * due.
   */
  private async tryEntryListSelectionFetch(nowMs: number): Promise<boolean> {
    if (this.entryListSessionKey === null || this.entryListSatisfied) return false;
    if (nowMs < this.entryListNextRetryAt) return false;
    const key = this.entryListSessionKey;

    let rows: RawRecord[] = [];
    let reason = "";
    try {
      const raw = await this.fetcher(`${OPENF1_BASE}/drivers?session_key=${key}`);
      rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
      if (rows.length === 0) reason = "no rows";
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    if (rows.length > 0) {
      const result = await this.emitAndRecordDrivers(rows, key);
      this.entryListSatisfied = true;
      this.log(
        `entry list: fetched session_key=${key} rows=${rows.length} new=${result.newRows} foreign=${result.foreign} unknown_session=${result.unknownSession}`,
      );
      return true;
    }

    if (!this.entryListFallbackEmitted) {
      const driverRows: RawRecord[] = ENTRY_LIST_2026.map((driver) => ({
        session_key: key,
        driver_number: driver.driver_number,
        full_name: driver.full_name,
        name_acronym: driver.name_acronym,
        team_name: driver.team_name,
        team_colour: driver.team_colour,
      }));
      await this.emitAndRecord("drivers", key, driverRows);
      this.entryListFallbackEmitted = true;
      this.log(`entry list: static fallback (${reason}) session_key=${key}`);
    }
    this.entryListNextRetryAt = nowMs + 5 * 60_000;
    return true;
  }

  /**
   * 5 minutes before `date_start`, the same `session_key` fetch
   * as the selection fetch, once — retried next tick (not the 5-minute
   * selection cadence) only when the fetch itself throws. A zero-row
   * response still counts as done (nothing to add, but the attempt
   * succeeded).
   */
  private async tryPreRaceRefresh(session: RawRecord, nowMs: number): Promise<boolean> {
    const key = Number(session["session_key"]);
    if (!Number.isFinite(key) || this.preRaceRefreshDone.has(key)) return false;
    const start = Date.parse(String(session["date_start"] ?? ""));
    if (Number.isNaN(start)) return false;
    if (nowMs < start - 5 * 60_000 || nowMs >= start) return false;

    let rows: RawRecord[];
    try {
      const raw = await this.fetcher(`${OPENF1_BASE}/drivers?session_key=${key}`);
      rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
    } catch (error) {
      this.log(
        `entry list: pre-race refresh failed for session_key=${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true; // not marked done: the next tick retries it
    }

    if (rows.length > 0) {
      const result = await this.emitAndRecordDrivers(rows, key);
      this.log(
        `entry list: pre-race refresh session_key=${key} rows=${rows.length} new=${result.newRows} foreign=${result.foreign} unknown_session=${result.unknownSession}`,
      );
    } else {
      this.log(`entry list: pre-race refresh session_key=${key} returned 0 rows`);
    }
    this.preRaceRefreshDone.add(key);
    return true;
  }

  /**
   * On discovery of a meeting whose first session's
   * `date_start` has passed and whose race session is already in the
   * `sessions` table, fetch `drivers?meeting_key=<meeting>` once per
   * meeting, retried every 30 minutes while it returns zero rows or fails.
   * Checks every known meeting but performs at most one fetch per call (the
   * budget rule) — the first meeting found due wins; the rest wait for a
   * later tick.
   */
  private async checkFridayFetch(sessions: RawRecord[], nowMs: number): Promise<boolean> {
    const byMeeting = new Map<number, RawRecord[]>();
    for (const s of sessions) {
      const meetingKey = Number(s["meeting_key"]);
      if (!Number.isFinite(meetingKey)) continue;
      const group = byMeeting.get(meetingKey);
      if (group) group.push(s);
      else byMeeting.set(meetingKey, [s]);
    }

    for (const [meetingKey, meetingSessions] of byMeeting) {
      const state = this.fridayMeetings.get(meetingKey);
      if (state?.satisfied) continue;
      if (state && nowMs < state.nextRetryAt) continue;

      // isRaceSession, not a raw session_type check: a sprint session
      // carries session_type "Race" too (session_name "Sprint"), and would
      // otherwise be picked here instead of the meeting's actual race.
      const raceSession = meetingSessions.find((s) => isRaceSession(s));
      if (!raceSession) continue;

      // The race session must already be in `knownSessionKeys` (its own
      // `sessions` upsert has landed) — `lastSessions` above holds every
      // fetched row regardless of upsert outcome, so this is the guard that
      // keeps a not-yet-written race session from triggering a meeting-wide
      // drivers fetch whose rows would just be dropped downstream as
      // unknownSession (events.session_key is a FK).
      const raceKey = Number(raceSession["session_key"]);
      if (!Number.isFinite(raceKey) || !this.knownSessionKeys.has(raceKey)) continue;

      // Friday's meeting-wide fetch applies only to a meeting whose race
      // session's window has not closed: `date_end` of the meeting's race
      // session + 30 minutes is still in the future. A meeting whose race is
      // over is never fetched; its entry list came in with the live sessions
      // or is already in the log.
      const raceEnd = Date.parse(String(raceSession["date_end"] ?? ""));
      if (Number.isNaN(raceEnd) || nowMs > raceEnd + LIVE_WINDOW_MS) continue;

      const starts = meetingSessions
        .map((s) => Date.parse(String(s["date_start"] ?? "")))
        .filter((n) => !Number.isNaN(n));
      if (starts.length === 0) continue;
      const firstStart = Math.min(...starts);
      if (nowMs < firstStart) continue;

      await this.runFridayFetch(meetingKey, nowMs);
      return true;
    }
    return false;
  }

  private async runFridayFetch(meetingKey: number, nowMs: number): Promise<void> {
    let rows: RawRecord[] = [];
    let reason = "";
    try {
      const raw = await this.fetcher(`${OPENF1_BASE}/drivers?meeting_key=${meetingKey}`);
      rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
      if (rows.length === 0) reason = "no rows";
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    if (rows.length > 0) {
      const result = await this.emitAndRecordDrivers(rows, null);
      this.fridayMeetings.set(meetingKey, { satisfied: true, nextRetryAt: nowMs });
      this.log(
        `entry list: friday fetch meeting_key=${meetingKey} rows=${rows.length} new=${result.newRows} foreign=${result.foreign} unknown_session=${result.unknownSession}`,
      );
    } else {
      this.fridayMeetings.set(meetingKey, { satisfied: false, nextRetryAt: nowMs + 30 * 60_000 });
      this.log(`entry list: friday fetch meeting_key=${meetingKey} deferred (${reason}); retrying in 30m`);
    }
  }

  /**
   * Runs at most one due drivers-type fetch (selection retry, then pre-race
   * refresh, then Friday) for the poll loop (pollOnce) to call BEFORE it
   * spends the tick's one request on the rotation: never more than one
   * drivers fetch per tick, and never inside the same tick as a rotation
   * poll that already used the budget (schedule them as rotation slots, not
   * extra requests). Returns whether it made
   * a request this tick.
   */
  private async runDueDriversFetch(nowMs: number): Promise<boolean> {
    if (await this.tryEntryListSelectionFetch(nowMs)) return true;
    if (this.session && (await this.tryPreRaceRefresh(this.session, nowMs))) return true;
    if (await this.checkFridayFetch(this.lastSessions, nowMs)) return true;
    return false;
  }

  /** One rotation step: fetch, normalize, enqueue. `null` when no session is active. */
  public async pollOnce(): Promise<PollResult | null> {
    if (this.sessionKey === null || this.session === null) return null;
    const nowMs = this.now();
    if (sessionExpired(this.session, nowMs)) {
      this.log(`rest: session ${this.sessionKey} left its live window; releasing`);
      this.session = null;
      this.sessionKey = null;
      return null;
    }

    // Budget rule: a due drivers fetch takes this tick's one
    // request instead of the rotation poll — `rotationIndex` is left
    // untouched so the rotation resumes at the same endpoint next tick,
    // nothing is skipped.
    if (await this.runDueDriversFetch(nowMs)) {
      return { endpoint: "drivers", rows: 0, newRows: 0, malformed: 0 };
    }

    // The idle discovery loop is off while live; refresh the sessions
    // snapshot on its cadence as this tick's one request, so a late upsert
    // (a race session that failed while FP1 went live) becomes known and
    // Friday's retry can fire on a later tick.
    if (nowMs >= this.nextSessionsRefreshAt) {
      await this.refreshSessions(nowMs);
      return { endpoint: "sessions", rows: 0, newRows: 0, malformed: 0 };
    }

    const endpoint = POLL_ROTATION[this.rotationIndex % POLL_ROTATION.length]!;
    this.rotationIndex += 1;
    const url = buildPollUrl(endpoint, this.sessionKey, null);
    let rows: unknown;
    try {
      rows = await this.fetcher(url);
    } catch (error) {
      this.log(`rest: poll ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { endpoint, rows: 0, newRows: 0, malformed: 0 };
    }
    const rawRows = Array.isArray(rows) ? (rows as RawRecord[]) : [];
    const { newRows, malformed } = await this.emitAndRecord(endpoint, this.sessionKey, rawRows);
    this.log(`rest: poll endpoint=${endpoint} rows=${rawRows.length} new=${newRows} malformed=${malformed}`);
    return { endpoint, rows: rawRows.length, newRows, malformed };
  }

  /** Thin wrapper around the free `emitRows()` that also feeds the jsonl recorder's `onNewRows`, once per call, only when there's something new. */
  private async emitAndRecord(
    endpoint: string,
    sessionKey: number,
    rows: RawRecord[],
  ): Promise<{ newRows: number; malformed: number }> {
    const result = emitRows(this.normalizer, this.queue, endpoint, sessionKey, rows);
    if (result.payloads.length > 0) {
      await this.onNewRows?.(sessionKey, endpoint, result.payloads);
    }
    return { newRows: result.newRows, malformed: result.malformed };
  }

  /**
   * `emitTaggedDriverRows` plus the jsonl recorder: `onNewRows` once per
   * session_key group that wrote something, so a real fetched entry list is
   * recorded exactly like the static fallback and every rotation poll. Rows
   * naming a session not yet upserted are dropped (see `knownSessionKeys`).
   */
  private async emitAndRecordDrivers(rows: RawRecord[], expectedSessionKey: number | null): Promise<EmitTaggedRowsResult> {
    const result = emitTaggedDriverRows(this.normalizer, this.queue, rows, expectedSessionKey, (key) =>
      this.knownSessionKeys.has(key),
    );
    for (const group of result.groups) {
      await this.onNewRows?.(group.sessionKey, "drivers", group.payloads);
    }
    return result;
  }

  /** Production loop: discovery while idle, rotation while a session is live. */
  public start(): void {
    this.running = true;
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      const tick = this.runOneTick();
      this.currentTick = tick;
      await tick;
      this.currentTick = null;
      if (!this.running) return;
      const delay = this.sessionKey === null ? this.discoveryIntervalMs : this.tickMs;
      this.timer = setTimeout(() => void loop(), delay);
    };
    this.timer = setTimeout(() => void loop(), 0);
  }

  private async runOneTick(): Promise<void> {
    try {
      if (this.sessionKey === null) {
        await this.discoverOnce();
      } else {
        await this.pollOnce();
      }
    } catch (error) {
      this.log(`rest: tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stops scheduling further ticks and resolves once any tick already
   * in-flight (awaiting the network) has finished — so its rows are in the
   * queue before the caller drains and exits (SIGTERM path in main.ts).
   */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.currentTick) await this.currentTick;
  }
}
