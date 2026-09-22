// The three drivers fetches and their retry state, from the ingest README's
// `## The entry list` (apps/ingest/README.md), verbatim:
//
// | Fetch | When | Retry | Stops when | Fallback |
// |---|---|---|---|---|
// | Selection fetch | `drivers?session_key=` immediately at session selection | Every 5 min | ≥ 1 row returned | The static list, emitted once |
// | Pre-race refresh | 5 min before `date_start`, same `session_key` fetch, once | Next tick, only if the fetch itself threw | Done after one successful attempt (a zero-row response still counts as done) | None |
// | Friday fetch | `drivers?meeting_key=`, once the meeting's first session has started, only while that meeting's race session is known and its window hasn't closed | Every 30 min | ≥ 1 row returned | None |
// | Budget rule | At most one drivers fetch per tick, taken before the rotation poll | — | — | — |
// | Static list | `openf1/entry-list.ts`, season-bound (`ENTRY_LIST_2026`); logs its season once at startup | — | — | — |

import { LIVE_WINDOW_MS, OPENF1_BASE } from "./discovery.js";
import type { CountStat } from "./discovery.js";
import { ENTRY_LIST_2026 } from "./entry-list.js";
import type { EnqueueDriverRowsResult } from "./enqueue.js";
import type { Fetcher, RawRecord } from "./types.js";
import type { LaneLog } from "../log.js";
import { isRaceSession } from "../writer/sessions.js";

export interface EntryListFetchesOptions {
  fetcher: Fetcher;
  /**
   * Queues and records `drivers` rows through the lane's current normalizer,
   * tagging each row by its own `session_key` (`enqueueDriverRows`).
   * `expectedSessionKey` is the session the fetch was made for, or `null`
   * for the meeting-wide Friday fetch, which has none to compare against.
   */
  enqueueDrivers: (rows: RawRecord[], expectedSessionKey: number | null) => Promise<EnqueueDriverRowsResult>;
  /** Queues and records rows already tagged to one session — the static fallback's path. */
  enqueueRows: (endpoint: string, sessionKey: number, rows: RawRecord[]) => Promise<{ newRows: number; malformed: number }>;
  /** Discovery's answer: has this session's own `sessions` upsert landed? */
  isKnownSession: (sessionKey: number) => boolean;
  countStat: CountStat;
  log: LaneLog;
}

/**
 * Owns the retry state of the three fetches above. Never imports
 * rest-lane.ts: the fetcher, the two enqueue paths, `isKnownSession`, the
 * stats sink and the log are injected, and the lane calls
 * `onSessionSelected` and `runDue` from its own loop.
 */
export class EntryListFetches {
  private readonly fetcher: Fetcher;
  private readonly enqueueDrivers: EntryListFetchesOptions["enqueueDrivers"];
  private readonly enqueueRows: EntryListFetchesOptions["enqueueRows"];
  private readonly isKnownSession: EntryListFetchesOptions["isKnownSession"];
  private readonly countStat: CountStat;
  private readonly log: LaneLog;

  // Selection fetch, reset when the lane selects a NEW session — never on
  // every discovery tick: retried every 5 minutes until the fetch returns
  // >= 1 row.
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

  public constructor(opts: EntryListFetchesOptions) {
    this.fetcher = opts.fetcher;
    this.enqueueDrivers = opts.enqueueDrivers;
    this.enqueueRows = opts.enqueueRows;
    this.isKnownSession = opts.isKnownSession;
    this.countStat = opts.countStat;
    this.log = opts.log;
  }

  /**
   * The lane has selected a new session: reset the selection state and make
   * the first attempt immediately (`entryListNextRetryAt = nowMs`). A
   * restart re-running this is harmless — the payload's own `session_key`
   * makes the event id unique per session, and `event.createMany`'s
   * skipDuplicates drops the repeat. Returns whether it fetched, so the
   * caller can charge the tick's one-drivers-fetch budget.
   */
  public async onSessionSelected(sessionKey: number, nowMs: number): Promise<boolean> {
    this.entryListSessionKey = sessionKey;
    this.entryListSatisfied = false;
    this.entryListFallbackEmitted = false;
    this.entryListNextRetryAt = nowMs;
    return this.trySelectionFetch(nowMs);
  }

  /**
   * Runs at most one due fetch — selection retry, then pre-race refresh,
   * then Friday — for the poll loop to call BEFORE it spends the tick's one
   * request on the rotation: never more than one drivers fetch per tick,
   * and never inside the same tick as a rotation poll. Returns whether it
   * made a request. See README: The entry list.
   */
  public async runDue(session: RawRecord | null, sessions: RawRecord[], nowMs: number): Promise<boolean> {
    if (await this.trySelectionFetch(nowMs)) return true;
    if (session && (await this.tryPreRaceRefresh(session, nowMs))) return true;
    if (await this.checkFridayFetch(sessions, nowMs)) return true;
    return false;
  }

  /**
   * Fetches `drivers?session_key=<selected>`, tags each row by its
   * own `session_key`, asserting it equals the selected key (a mismatch is
   * still written, tagged to the session it names, and counted `foreign` —
   * never dropped). Zero rows or a failure: emit the static
   * ENTRY_LIST_2026 fallback once, then keep retrying every 5 minutes until
   * the fetch returns >= 1 row, at which point those rows are emitted too
   * (the writer's dedup makes the overlap with the fallback harmless).
   */
  private async trySelectionFetch(nowMs: number): Promise<boolean> {
    if (this.entryListSessionKey === null || this.entryListSatisfied) return false;
    if (nowMs < this.entryListNextRetryAt) return false;
    const key = this.entryListSessionKey;

    let rows: RawRecord[] = [];
    let reason = "";
    this.countStat("polls");
    try {
      const raw = await this.fetcher(`${OPENF1_BASE}/drivers?session_key=${key}`);
      rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
      if (rows.length === 0) reason = "no rows";
    } catch (error) {
      this.countStat("errors");
      reason = error instanceof Error ? error.message : String(error);
    }

    if (rows.length > 0) {
      const result = await this.enqueueDrivers(rows, key);
      this.countStat("rows", result.newRows);
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
      const result = await this.enqueueRows("drivers", key, driverRows);
      this.countStat("rows", result.newRows);
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
    this.countStat("polls");
    try {
      const raw = await this.fetcher(`${OPENF1_BASE}/drivers?session_key=${key}`);
      rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
    } catch (error) {
      this.countStat("errors");
      this.log(
        `entry list: pre-race refresh failed for session_key=${key}: ${error instanceof Error ? error.message : String(error)}`,
        { level: "error" },
      );
      return true; // not marked done: the next tick retries it
    }

    if (rows.length > 0) {
      const result = await this.enqueueDrivers(rows, key);
      this.countStat("rows", result.newRows);
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
   * budget rule) — the first meeting found due wins; the rest wait.
   */
  public async checkFridayFetch(sessions: RawRecord[], nowMs: number): Promise<boolean> {
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

      // The race session's own `sessions` upsert must already have landed
      // (discovery's `isKnownSession`) — the snapshot holds every fetched
      // row regardless of upsert outcome, so this is the guard that keeps a
      // not-yet-written race session from triggering a meeting-wide drivers
      // fetch whose rows would just be dropped downstream as unknownSession
      // (events.session_key is a FK).
      const raceKey = Number(raceSession["session_key"]);
      if (!Number.isFinite(raceKey) || !this.isKnownSession(raceKey)) continue;

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
    this.countStat("polls");
    try {
      const raw = await this.fetcher(`${OPENF1_BASE}/drivers?meeting_key=${meetingKey}`);
      rows = Array.isArray(raw) ? (raw as RawRecord[]) : [];
      if (rows.length === 0) reason = "no rows";
    } catch (error) {
      this.countStat("errors");
      reason = error instanceof Error ? error.message : String(error);
    }

    if (rows.length > 0) {
      const result = await this.enqueueDrivers(rows, null);
      this.countStat("rows", result.newRows);
      this.fridayMeetings.set(meetingKey, { satisfied: true, nextRetryAt: nowMs });
      this.log(
        `entry list: friday fetch meeting_key=${meetingKey} rows=${rows.length} new=${result.newRows} foreign=${result.foreign} unknown_session=${result.unknownSession}`,
      );
    } else {
      this.fridayMeetings.set(meetingKey, { satisfied: false, nextRetryAt: nowMs + 30 * 60_000 });
      this.log(`entry list: friday fetch meeting_key=${meetingKey} deferred (${reason}); retrying in 30m`);
    }
  }
}
