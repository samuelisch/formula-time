// Session discovery: the `sessions?year=` / `meetings?year=` snapshot the
// rest of the REST lane reads. Owns the snapshot, the meeting-name map, the
// session keys whose `sessions` upsert has landed, and the refresh cadence.
// Never imports rest-lane.ts: the fetcher, the callbacks and the lane's
// stats sink are injected, so the lane stays the only caller.

import type { RecordRows } from "./enqueue.js";
import type { Fetcher, RawRecord } from "./types.js";
import type { LaneLog } from "../log.js";
import { isRaceSession } from "../writer/sessions.js";

export const OPENF1_BASE = "https://api.openf1.org/v1";

// OpenF1 serves live data from 30 minutes before `date_start` to 30 minutes
// after `date_end`. The window is one rule, so the two predicates derived
// from it live beside it; rest-lane.ts re-exports both.
export const LIVE_WINDOW_MS = 30 * 60 * 1000;

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

/**
 * The REST lane's four counters, written through from wherever the fetch
 * happened: discovery and the entry-list fetches report into the lane's one
 * `takeStats()` instead of keeping counters of their own.
 */
export type CountStat = (stat: "polls" | "rows" | "errors" | "unjoined", n?: number) => void;

export interface SessionDiscoveryOptions {
  fetcher: Fetcher;
  year: number;
  /** How long a `sessions?year=` snapshot stays fresh — the lane's discovery cadence. */
  intervalMs: number;
  /**
   * Sessions upsert — called for every race session row this sees.
   * `meetingNames` is this tick's `meeting_key -> meeting_name` map, for
   * `sessionFieldsFromRaw`'s join.
   */
  onSession?: ((session: RawRecord, nowMs: number, meetingNames: ReadonlyMap<number, string>) => void | Promise<void>) | undefined;
  /** The lane's recorder wrapper, used only for the followed session's own `meetings` row. */
  onRecorded: RecordRows;
  countStat: CountStat;
  log: LaneLog;
}

export class SessionDiscovery {
  private readonly fetcher: Fetcher;
  private readonly year: number;
  private readonly intervalMs: number;
  private readonly onSession: SessionDiscoveryOptions["onSession"];
  private readonly onRecorded: RecordRows;
  private readonly countStat: CountStat;
  private readonly log: LaneLog;

  // The last `sessions?year=` snapshot: every row the fetch returned, race
  // or not. The Friday entry-list check groups a meeting's sessions from it,
  // and discovery stops running once a session is live, so the lane reuses
  // this snapshot instead of refetching.
  private lastSessions: RawRecord[] = [];
  // meeting_key -> meeting_name, refetched once per tick alongside the
  // sessions snapshot. A fetch failure keeps the previous map rather than
  // clearing it, so a transient error doesn't blank out every session's
  // meeting_name on the next upsert.
  private meetingNameByKey: ReadonlyMap<number, string> = new Map();
  // The raw rows from the most recent successful `refreshMeetingNames`
  // fetch — kept so the followed-session recording check can reuse this
  // tick's fetch instead of refetching.
  private lastMeetingRows: RawRecord[] = [];
  // Every session_key whose `sessions` upsert has succeeded at least once
  // (this process). A drivers row tagged to any other key must not be
  // queued: `events.session_key` is a FK, one such row fails the writer's
  // whole batch, and the writer requeues that batch at the front forever.
  private readonly knownSessionKeys = new Set<number>();
  // The followed session's own meetings row is recorded at most once per
  // session_key — this Set is that "already fired" marker.
  private readonly meetingRowRecordedFor = new Set<number>();
  // While a session is live the idle discovery loop does not run, so the
  // snapshot (and knownSessionKeys) would freeze: a race session whose
  // upsert had not landed before FP1 went live would never become known and
  // Friday's 30-minute retry would never fire. The lane refreshes on this
  // cadence from its poll loop instead.
  private nextSessionsRefreshAt = 0;

  public constructor(opts: SessionDiscoveryOptions) {
    this.fetcher = opts.fetcher;
    this.year = opts.year;
    this.intervalMs = opts.intervalMs;
    this.onSession = opts.onSession;
    this.onRecorded = opts.onRecorded;
    this.countStat = opts.countStat;
    this.log = opts.log;
  }

  /** The last snapshot: every session row the most recent successful fetch returned. */
  public sessions(): RawRecord[] {
    return this.lastSessions;
  }

  /** This tick's `meeting_key -> meeting_name` map, as handed to `onSession`. */
  public meetingNames(): ReadonlyMap<number, string> {
    return this.meetingNameByKey;
  }

  /** Whether this session's own `sessions` upsert has landed (`events.session_key` is a FK). */
  public isKnownSession(sessionKey: number): boolean {
    return this.knownSessionKeys.has(sessionKey);
  }

  /** The most recent `meetings?year=` row for this meeting, matched by its own `meeting_key`. */
  public meetingRowFor(meetingKey: number): RawRecord | undefined {
    return this.lastMeetingRows.find((m) => Number(m["meeting_key"]) === meetingKey);
  }

  /** Whether the snapshot is stale — the live poll loop's cue to spend a tick refreshing it. */
  public sessionsRefreshDue(nowMs: number): boolean {
    return nowMs >= this.nextSessionsRefreshAt;
  }

  /**
   * `sessions?year=` plus the upsert of every race row: refreshes the
   * snapshot (every row this fetch returned, race or not) and
   * `knownSessionKeys` (race rows whose upsert succeeded only). Shared by
   * the idle discovery tick and the live loop's periodic refresh. `null`
   * when the fetch failed or returned no array.
   */
  public async refreshSessions(nowMs: number): Promise<{ rows: RawRecord[]; upserted: Set<RawRecord> } | null> {
    this.nextSessionsRefreshAt = nowMs + this.intervalMs;
    let sessions: unknown;
    this.countStat("polls");
    try {
      sessions = await this.fetcher(`${OPENF1_BASE}/sessions?year=${this.year}`);
    } catch (error) {
      this.countStat("errors");
      this.log(`rest: session discovery failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: "error",
      });
      return null;
    }
    if (!Array.isArray(sessions)) return null;
    const rows = sessions as RawRecord[];

    // Refreshed alongside the sessions snapshot, once per tick.
    await this.refreshMeetingNames();

    // Only race sessions are captured (isRaceSession): a practice,
    // qualifying or sprint row is never upserted, never added to
    // `upserted`, and never added to `knownSessionKeys` — so the lane's
    // selection can't pick it and a drivers row tagged to it is dropped
    // downstream as unknownSession.
    //
    // `upserted` tracks which rows' onSession succeeded THIS tick, so the
    // lane never selects a session whose row failed to write: every later
    // event insert would fail its FK against a row that was never created.
    const upserted = new Set<RawRecord>();
    for (const row of rows) {
      if (!isRaceSession(row)) continue;
      try {
        await this.onSession?.(row, nowMs, this.meetingNameByKey);
        upserted.add(row);
        const key = Number(row["session_key"]);
        if (Number.isFinite(key)) this.knownSessionKeys.add(key);
      } catch (error) {
        // One malformed row (bad session_key, bad date) must not throw out
        // of this loop and starve selection or the Friday entry-list check
        // every discovery tick — sessions.ts's upsertSession is what
        // actually validates and throws; this is where ingest survives it.
        this.log(`rest: session row skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.lastSessions = rows;
    return { rows, upserted };
  }

  /**
   * `meetings?year=<current>`, once per discovery tick — the session row
   * never carries the Grand Prix name itself, so `sessionFieldsFromRaw`
   * joins it from this map by `meeting_key`. A fetch failure or a
   * non-array response leaves the previous tick's map in place rather than
   * clearing it.
   */
  private async refreshMeetingNames(): Promise<void> {
    let meetings: unknown;
    this.countStat("polls");
    try {
      meetings = await this.fetcher(`${OPENF1_BASE}/meetings?year=${this.year}`);
    } catch (error) {
      this.countStat("errors");
      this.log(`rest: meetings fetch failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: "error",
      });
      this.lastMeetingRows = [];
      return;
    }
    if (!Array.isArray(meetings)) {
      this.lastMeetingRows = [];
      return;
    }
    const rows = meetings as RawRecord[];
    this.lastMeetingRows = rows;
    const map = new Map<number, string>();
    for (const meeting of rows) {
      const key = Number(meeting["meeting_key"]);
      const name = meeting["meeting_name"];
      if (Number.isFinite(key) && typeof name === "string" && name.length > 0) map.set(key, name);
    }
    this.meetingNameByKey = map;
  }

  /**
   * Records the followed session's own meetings row, once, through the
   * injected recorder (endpoint `"meetings"`) — the same jsonl path every
   * other endpoint uses, so a later `pnpm ingest:load` of this session's
   * recording can source `meeting_name` too. Must run AFTER the lane has
   * selected a session, which is why the lane calls it rather than
   * `refreshSessions` doing it inline. See README: The pipeline.
   */
  public async recordFollowedMeetingRow(session: RawRecord | null, sessionKey: number | null): Promise<void> {
    if (sessionKey === null || session === null) return;
    if (this.meetingRowRecordedFor.has(sessionKey)) return;
    const meetingKey = Number(session["meeting_key"]);
    if (!Number.isFinite(meetingKey)) return;
    const row = this.meetingRowFor(meetingKey);
    if (!row) return;
    await this.onRecorded(sessionKey, "meetings", [row]);
    this.meetingRowRecordedFor.add(sessionKey);
  }
}
