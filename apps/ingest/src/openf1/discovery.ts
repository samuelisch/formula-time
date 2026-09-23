// Session discovery: the `sessions?year=` / `meetings?year=` snapshot the
// rest of the REST lane reads. Owns the snapshot, the meeting-name map, the
// session keys whose `sessions` upsert has landed, and the refresh cadence.
// Never imports rest-lane.ts: the fetcher, the callbacks and the lane's
// stats sink are injected, so the lane stays the only caller.

import type { RecordRows } from "./enqueue.js";
import type { Fetcher, RawRecord } from "./types.js";
import { CIRCUITS } from "../circuits.js";
import type { LaneLog } from "../log.js";
import { isRaceSession } from "../writer/sessions.js";

// The window the coverage check calls "soon": a race inside it without a
// lap count logs at error level instead of info.
const COVERAGE_SOON_MS = 14 * 24 * 60 * 60 * 1000;

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
  /** Test override: pins the fetch year regardless of the clock. Production omits this (or passes `undefined`) and lets `yearOf` read the year off `nowMs` at each fetch. */
  year?: number | undefined;
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
  private readonly yearOverride: number | undefined;
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
  // The season coverage lines fire once, at the first successful
  // refreshSessions (startup, or the first retry after a startup
  // failure) — never again, and never reset.
  private coverageChecked = false;

  public constructor(opts: SessionDiscoveryOptions) {
    this.fetcher = opts.fetcher;
    this.yearOverride = opts.year;
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

  /** The calendar year a fetch made at `nowMs` reads, UTC. */
  private yearOf(nowMs: number): number {
    return new Date(nowMs).getUTCFullYear();
  }

  /**
   * The year(s) a discovery fetch reads this tick. In December (UTC month
   * 11) both the current and the next year are fetched, so a January race
   * is discovered before its Friday instead of only after the rollover.
   * The constructor `year` override pins a single year and skips this.
   */
  private yearsToFetch(nowMs: number): number[] {
    if (this.yearOverride !== undefined) return [this.yearOverride];
    const year = this.yearOf(nowMs);
    return new Date(nowMs).getUTCMonth() === 11 ? [year, year + 1] : [year];
  }

  /**
   * `sessions?year=` plus the upsert of every race row: refreshes the
   * snapshot (every row returned, race or not) and `knownSessionKeys`
   * (race rows whose upsert succeeded). Shared by the idle discovery
   * tick and the live loop's periodic refresh; `null` on failure.
   */
  public async refreshSessions(nowMs: number): Promise<{ rows: RawRecord[]; upserted: Set<RawRecord> } | null> {
    this.nextSessionsRefreshAt = nowMs + this.intervalMs;
    const years = this.yearsToFetch(nowMs);
    // A session cannot appear under two different years, but the fetches
    // are concatenated from separate responses, so dedupe by session_key
    // defensively rather than trust that.
    const seenKeys = new Set<number>();
    const rows: RawRecord[] = [];
    for (const year of years) {
      let sessions: unknown;
      this.countStat("polls");
      try {
        sessions = await this.fetcher(`${OPENF1_BASE}/sessions?year=${year}`);
      } catch (error) {
        this.countStat("errors");
        this.log(`rest: session discovery failed: ${error instanceof Error ? error.message : String(error)}`, {
          level: "error",
        });
        return null;
      }
      if (!Array.isArray(sessions)) return null;
      for (const row of sessions as RawRecord[]) {
        const key = Number(row["session_key"]);
        if (Number.isFinite(key)) {
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
        }
        rows.push(row);
      }
    }

    // Refreshed alongside the sessions snapshot, once per tick.
    await this.refreshMeetingNames(years);

    // Only race sessions are captured (isRaceSession): a practice,
    // qualifying or sprint row is never upserted or added to
    // `knownSessionKeys`, so a drivers row tagged to it is dropped
    // downstream as unknownSession. `upserted` tracks which rows'
    // onSession succeeded this tick, so the lane never selects a
    // session whose row failed to write.
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
    if (!this.coverageChecked) {
      this.coverageChecked = true;
      this.checkSeasonCoverage(rows, nowMs);
    }
    return { rows, upserted };
  }

  /**
   * Logs each upcoming race session whose circuit_key has no lap count in
   * `CIRCUITS` (writer/sessions.ts: `total_laps` stays null, so the api
   * never opens polls for it), then a summary line — once, at the first
   * successful discovery. `refreshSessions` guards this to run only then.
   */
  private checkSeasonCoverage(rows: RawRecord[], nowMs: number): void {
    const upcoming = rows.filter((row) => {
      if (!isRaceSession(row)) return false;
      const start = Date.parse(String(row["date_start"] ?? ""));
      return !Number.isNaN(start) && start > nowMs;
    });
    let covered = 0;
    for (const row of upcoming) {
      const circuitKey = Number(row["circuit_key"] ?? NaN);
      if (Number.isFinite(circuitKey) && circuitKey in CIRCUITS) {
        covered += 1;
        continue;
      }
      const start = Date.parse(String(row["date_start"] ?? ""));
      const msUntil = start - nowMs;
      const level = msUntil <= COVERAGE_SOON_MS ? "error" : "info";
      const sessionKey = row["session_key"];
      const circuitShortName = row["circuit_short_name"];
      const dateStart = row["date_start"];
      this.log(
        `ingest: no lap count for session_key=${String(sessionKey)} circuit_key=${circuitKey} (${String(circuitShortName)}, ${String(dateStart)}); polls will not open`,
        {
          level,
          fields: {
            session_key: typeof sessionKey === "number" || typeof sessionKey === "string" ? sessionKey : String(sessionKey),
            circuit_key: circuitKey,
            days_until: Math.floor(msUntil / (24 * 60 * 60 * 1000)),
          },
        },
      );
    }
    this.log(`ingest: season coverage ${covered}/${upcoming.length} upcoming races have a lap count`);
  }

  /**
   * `meetings?year=`, once per discovery tick per year in `years` (the
   * same December-rollover years `refreshSessions` fetched). See README:
   * Session upsert. A fetch failure or non-array response for any year
   * aborts the refresh and leaves the previous tick's map in place
   * instead of clearing it.
   */
  private async refreshMeetingNames(years: number[]): Promise<void> {
    // A meeting cannot appear under two different years, but the fetches
    // are concatenated from separate responses, so dedupe by meeting_key
    // defensively rather than trust that (same rationale as refreshSessions).
    const seenKeys = new Set<number>();
    const rows: RawRecord[] = [];
    for (const year of years) {
      let meetings: unknown;
      this.countStat("polls");
      try {
        meetings = await this.fetcher(`${OPENF1_BASE}/meetings?year=${year}`);
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
      for (const meeting of meetings as RawRecord[]) {
        const key = Number(meeting["meeting_key"]);
        if (Number.isFinite(key)) {
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
        }
        rows.push(meeting);
      }
    }
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
   * injected recorder — must run after session selection, so the lane
   * calls it rather than `refreshSessions` doing it inline. See README:
   * The pipeline.
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
