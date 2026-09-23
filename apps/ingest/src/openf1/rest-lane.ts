// The REST lane: the tick loop, the session selection, and the weighted
// rotation. Lifted from `../f1-live-events-poc/poc/ts/live_capture.ts`
// (`POLL_ROTATION`, `buildPollUrl`, `Fetcher`, the loop shape). Discovery
// is in discovery.ts, the drivers fetches in entry-list-fetches.ts; ingest
// never folds, so `LiveRace` / `state_authority` are not lifted.

import path from "node:path";

import { OPENF1_BASE, SessionDiscovery, pickLiveSession, sessionExpired } from "./discovery.js";
import type { CountStat } from "./discovery.js";
import { EntryListFetches } from "./entry-list-fetches.js";
import { enqueueDriverRows, enqueueRows } from "./enqueue.js";
import type { EnqueueDriverRowsResult, RecordRows } from "./enqueue.js";
import { LiveNormalizer, endpointConfigs } from "./normalize.js";
import type { Fetcher, QueueItem, RawRecord } from "./types.js";
import type { LaneLog } from "../log.js";
import type { EventQueue } from "../writer/queue.js";
import { isRaceSession } from "../writer/sessions.js";

// The live window and its two predicates live with the snapshot that uses
// them; re-exported so the loaders and the tests keep their imports.
export { OPENF1_BASE, pickLiveSession, sessionExpired } from "./discovery.js";

// Weighted rotation: hot endpoints appear most often. 21 slots; at a 2.2s
// tick a full cycle is ~46s (~27 req/min). See README: Rules.
export const POLL_ROTATION: string[] = [
  "position", "intervals", "laps", "race_control",
  "position", "intervals", "weather",
  "position", "intervals", "pit",
  "position", "intervals", "laps", "race_control",
  "position", "intervals", "stints",
  "position", "intervals", "position", "intervals",
];

// The live API rejects every date filter, so the lane always calls this
// with `cursor: null` and relies on the normalizer's dedup instead. The
// parameter is kept from the POC signature. See README: OpenF1 facts.
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

export interface RestLaneOptions {
  fetcher?: Fetcher;
  year?: number;
  now?: () => number;
  /** Rotation cadence once a session is live. Default matches the POC: 2200ms. */
  tickMs?: number;
  /** Discovery cadence while no session is in its window. Default: every 60 s. */
  discoveryIntervalMs?: number;
  /** The recorder's root (`LIVE_LOG_DIR`), used only to name the directory in the closed-recording log line. */
  liveLogDir?: string;
  /** Sessions upsert, called for every race row discovery sees, with this tick's `meeting_key -> meeting_name` map. */
  onSession?: (session: RawRecord, nowMs: number, meetingNames: ReadonlyMap<number, string>) => void | Promise<void>;
  /** Called once when a session is newly selected, not every discovery tick: where writing the recorder's `session.json` belongs. */
  onSessionSelected?: (session: RawRecord, nowMs: number) => void | Promise<void>;
  /**
   * The jsonl recorder callback, passed through to every enqueue call, so a
   * row is recorded the moment it is queued. Also called for the followed
   * session's `meetings` row, recorded but never queued.
   */
  onRecorded?: RecordRows;
  onLog?: LaneLog;
}

export interface PollResult {
  endpoint: string;
  rows: number;
  newRows: number;
  malformed: number;
}

/** REST activity `takeStats()` returns and resets — feeds `main.ts`'s per-minute `ingest: last 60s` line. */
export interface RestLaneStats {
  polls: number;
  rows: number;
  errors: number;
  /** `stints` rows normalized with a null `sourceTime` (their lap hadn't been seen yet) — an out-of-order stint. */
  unjoined: number;
}

export class RestLane {
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly onSessionSelected: RestLaneOptions["onSessionSelected"];
  private readonly onRecordedCallback: RestLaneOptions["onRecorded"];
  private readonly liveLogDir: string;
  private readonly log: LaneLog;
  private readonly discovery: SessionDiscovery;
  private readonly entryList: EntryListFetches;
  // Every REST call this lane, discovery and the entry-list fetches make,
  // and the rows and errors they produced, since the last takeStats().
  private stats: RestLaneStats = { polls: 0, rows: 0, errors: 0, unjoined: 0 };
  // Rows recorded for the currently followed session only — reset when a NEW
  // session is selected, reported once in the closed-recording log line.
  private followedRecordedRows = 0;

  private normalizer = new LiveNormalizer();
  private session: RawRecord | null = null;
  private sessionKey: number | null = null;
  private rotationIndex = 0;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  // The tick currently awaiting the network, so `stop()` can wait for it
  // instead of enqueueing rows after the writer drained (SIGTERM race).
  private currentTick: Promise<void> | null = null;

  public constructor(private readonly queue: EventQueue<QueueItem>, opts: RestLaneOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 2200;
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 60_000;
    this.onSessionSelected = opts.onSessionSelected;
    this.onRecordedCallback = opts.onRecorded;
    this.liveLogDir = opts.liveLogDir ?? "./live-logs";
    this.log = opts.onLog ?? ((): void => {});
    this.discovery = new SessionDiscovery({
      fetcher: this.fetcher,
      // Test override only — SessionDiscovery reads the year off nowMs at
      // each fetch (ADR-0043).
      year: opts.year,
      intervalMs: this.discoveryIntervalMs,
      onSession: opts.onSession,
      onRecorded: this.recordRows,
      countStat: this.countStat,
      log: this.log,
    });
    this.entryList = new EntryListFetches({
      fetcher: this.fetcher,
      enqueueDrivers: (rows, expectedSessionKey) => this.enqueueAndRecordDrivers(rows, expectedSessionKey),
      enqueueRows: (endpoint, sessionKey, rows) => this.enqueueAndRecord(endpoint, sessionKey, rows),
      isKnownSession: (key) => this.discovery.isKnownSession(key),
      countStat: this.countStat,
      log: this.log,
    });
  }

  public status(): { active: boolean; sessionKey: number | null } {
    return { active: this.sessionKey !== null, sessionKey: this.sessionKey };
  }

  /** The one place every REST call this lane makes, wherever it was made, is counted. */
  private readonly countStat: CountStat = (stat, n = 1): void => {
    this.stats[stat] += n;
  };

  /** Polls/rows/errors since the previous call, then reset to zero. */
  public takeStats(): RestLaneStats {
    const stats = this.stats;
    this.stats = { polls: 0, rows: 0, errors: 0, unjoined: 0 };
    return stats;
  }

  /** The normalizer the MQTT lane rides: REST is the authority on which session is live, so MQTT shares this instance, swapped out on a new selection. */
  public getNormalizer(): LiveNormalizer {
    return this.normalizer;
  }

  /**
   * One discovery tick: refresh the snapshot, upsert every session it sees,
   * select the live one for the rotation, then the idle loop's own Friday
   * check and the followed session's `meetings` row.
   */
  public async discoverOnce(): Promise<{ sessionCount: number; live: boolean }> {
    const nowMs = this.now();
    const refreshed = await this.discovery.refreshSessions(nowMs);
    if (refreshed === null) return { sessionCount: 0, live: this.sessionKey !== null };
    const { rows, upserted } = refreshed;

    // The one-drivers-fetch-per-tick rule holds here too: a session
    // discovered inside its window fetches its entry list at selection, and
    // Friday's meeting-wide fetch waits for the next tick.
    const selectionFetched = await this.ensureLiveSession(rows, nowMs, upserted);
    if (!selectionFetched) await this.entryList.checkFridayFetch(this.discovery.sessions(), nowMs);

    // After ensureLiveSession: a session selected THIS tick is already
    // this.session/this.sessionKey.
    await this.discovery.recordFollowedMeetingRow(this.session, this.sessionKey);

    return { sessionCount: rows.length, live: this.sessionKey !== null };
  }

  /**
   * The `onRecorded` callback handed to every enqueue call, and to discovery
   * for the `meetings` row. Counts a recorded row toward the closed-recording
   * line's `rows=<n>`; a rejected write is logged and swallowed, since the
   * row is queued either way.
   */
  private readonly recordRows = async (sessionKey: number, endpoint: string, rows: RawRecord[]): Promise<void> => {
    try {
      await this.onRecordedCallback?.(sessionKey, endpoint, rows);
      if (sessionKey === this.sessionKey) this.followedRecordedRows += rows.length;
    } catch (error) {
      this.log(`rest: recording failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: "error",
        fields: { endpoint },
      });
    }
  };

  /** Returns whether it made a drivers fetch this tick (the selection fetch). */
  private async ensureLiveSession(sessions: RawRecord[], nowMs: number, upserted: Set<RawRecord>): Promise<boolean> {
    const live = pickLiveSession(sessions, nowMs);
    if (!live) return false;
    // Only race sessions are captured: a practice or qualifying session in
    // its window is left unselected. Not an error, the common practice day.
    if (!isRaceSession(live)) return false;
    if (!upserted.has(live)) {
      // Its sessions upsert failed this tick — selecting it anyway would
      // fail every later event insert's FK. The next tick retries it.
      this.log("rest: session not selected: upsert failed");
      return false;
    }
    const key = Number(live["session_key"]);
    if (!Number.isFinite(key)) return false;
    if (this.sessionKey === key) return false;

    this.session = live;
    this.sessionKey = key;
    this.normalizer = new LiveNormalizer();
    this.rotationIndex = 0;
    this.followedRecordedRows = 0;
    this.log(`rest: following session_key=${key} (${String(live["country_name"] ?? "?")})`);
    // Once per newly-selected session, never per discovery tick: from
    // onSession this would re-stamp session.json for the whole year.
    await this.onSessionSelected?.(live, nowMs);
    // The entry list's selection fetch belongs to this new session; its
    // return value charges the tick's one-drivers-fetch budget.
    return this.entryList.onSessionSelected(key, nowMs);
  }

  /** One rotation step: fetch, normalize, enqueue. `null` when no session is active. */
  public async pollOnce(): Promise<PollResult | null> {
    if (this.sessionKey === null || this.session === null) return null;
    const nowMs = this.now();
    if (sessionExpired(this.session, nowMs)) {
      const recordingDir = path.join(this.liveLogDir, String(this.sessionKey));
      this.log(`recording closed ${this.sessionKey} rows=${this.followedRecordedRows} path=${recordingDir}`, {
        fields: { rows: this.followedRecordedRows },
      });
      this.log(`rest: session ${this.sessionKey} left its live window; releasing`);
      this.session = null;
      this.sessionKey = null;
      return null;
    }

    // Budget rule: a due drivers fetch takes this tick's one request instead
    // of the rotation poll. `rotationIndex` is untouched, so the rotation
    // resumes at the same endpoint next tick and nothing is skipped.
    if (await this.entryList.runDue(this.session, this.discovery.sessions(), nowMs)) {
      return { endpoint: "drivers", rows: 0, newRows: 0, malformed: 0 };
    }

    // The idle discovery loop is off while live; refresh the snapshot on
    // its cadence as this tick's one request, so a late upsert becomes known
    // and a `meetings` row arriving after selection is still recorded.
    if (this.discovery.sessionsRefreshDue(nowMs)) {
      await this.discovery.refreshSessions(nowMs);
      await this.discovery.recordFollowedMeetingRow(this.session, this.sessionKey);
      return { endpoint: "sessions", rows: 0, newRows: 0, malformed: 0 };
    }

    const endpoint = POLL_ROTATION[this.rotationIndex % POLL_ROTATION.length]!;
    this.rotationIndex += 1;
    const url = buildPollUrl(endpoint, this.sessionKey, null);
    let rows: unknown;
    this.countStat("polls");
    try {
      rows = await this.fetcher(url);
    } catch (error) {
      this.countStat("errors");
      this.log(`rest: poll ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`, {
        level: "error",
      });
      return { endpoint, rows: 0, newRows: 0, malformed: 0 };
    }
    const rawRows = Array.isArray(rows) ? (rows as RawRecord[]) : [];
    const { newRows, malformed } = await this.enqueueAndRecord(endpoint, this.sessionKey, rawRows);
    this.countStat("rows", newRows);
    this.log(`rest: poll endpoint=${endpoint} rows=${rawRows.length} new=${newRows} malformed=${malformed}`);
    return { endpoint, rows: rawRows.length, newRows, malformed };
  }

  /** The lane's one normalize-enqueue-record path, through the current normalizer. */
  private async enqueueAndRecord(endpoint: string, sessionKey: number, rows: RawRecord[]): Promise<{ newRows: number; malformed: number }> {
    const result = await enqueueRows(this.normalizer, this.queue, endpoint, sessionKey, rows, this.recordRows);
    this.countStat("unjoined", result.unjoined);
    return { newRows: result.newRows, malformed: result.malformed };
  }

  /** The same path for `drivers` rows, tagged to the `session_key` in their own payload. */
  private async enqueueAndRecordDrivers(rows: RawRecord[], expectedSessionKey: number | null): Promise<EnqueueDriverRowsResult> {
    const isKnown = (key: number): boolean => this.discovery.isKnownSession(key);
    const result = await enqueueDriverRows(this.normalizer, this.queue, rows, expectedSessionKey, isKnown, this.recordRows);
    this.countStat("unjoined", result.unjoined);
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
      this.countStat("errors");
      this.log(`rest: tick failed: ${error instanceof Error ? error.message : String(error)}`, { level: "error" });
    }
  }

  /** Stops scheduling ticks and resolves once any in-flight tick has finished, so its rows are queued before the caller drains (SIGTERM). */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.currentTick) await this.currentTick;
  }
}
