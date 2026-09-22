// The REST lane. Lifted from
// `../f1-live-events-poc/poc/ts/live_capture.ts` (`OPENF1_BASE`,
// `POLL_ROTATION`, `pickLiveSession`, `sessionExpired`, `buildPollUrl`,
// `Fetcher`, the polling-loop shape) and
// `../f1-live-events-poc/poc/live-recorder/recorder.ts` (discovery, the
// "poll the full endpoint every time, dedup by eventId" cadence — the live
// API rejects every date filter; apps/ingest/AGENTS.md). Does NOT lift
// `LiveRace` / `state_authority` / `session_registry`: ingest never folds.

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

// The live window and the two predicates over it moved to discovery.ts with
// the snapshot that uses them; re-exported here so every existing import
// (the loaders, the tests) keeps working.
export { OPENF1_BASE, pickLiveSession, sessionExpired } from "./discovery.js";

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

export interface RestLaneOptions {
  fetcher?: Fetcher;
  year?: number;
  now?: () => number;
  /** Rotation cadence once a session is live. Default matches the POC: 2200ms. */
  tickMs?: number;
  /** Discovery cadence while no session is in its window. Default: every 60 s. */
  discoveryIntervalMs?: number;
  /**
   * The jsonl recorder's root directory (config.ts's `LIVE_LOG_DIR`) — used
   * only to name the recording directory in the closed-recording log line
   * ("recording closed <session_key> rows=<n> path=<dir>"); the lane never
   * touches the filesystem itself, the recorder does.
   */
  liveLogDir?: string;
  /**
   * Sessions upsert — called for every session row discovery sees.
   * `meetingNames` is this tick's `meeting_key -> meeting_name` map (see
   * `refreshMeetingNames`), for `sessionFieldsFromRaw`'s join.
   */
  onSession?: (session: RawRecord, nowMs: number, meetingNames: ReadonlyMap<number, string>) => void | Promise<void>;
  /**
   * Called once, when a session is newly selected as the one being followed
   * (`this.sessionKey` changes) — NOT on every discovery tick like
   * `onSession`. This is where a per-session, one-time side effect (writing
   * the jsonl recorder's `session.json`) belongs, so it doesn't re-run every
   * 60s while nothing is live.
   */
  onSessionSelected?: (session: RawRecord, nowMs: number) => void | Promise<void>;
  /**
   * The jsonl recorder callback, passed straight through to every
   * `enqueueRows`/`enqueueDriverRows` call this lane makes, so a row is
   * recorded at the moment it is queued. Also called directly, outside
   * `enqueueRows`, for the followed session's own `meetings` row, once, the
   * first tick it is available (endpoint `"meetings"`) — that row is never
   * queued to `events` (`meetings` isn't a stored endpoint), only recorded,
   * so a later `pnpm ingest:load` of this session's recording can source
   * `meeting_name` too (`meetingNamesFromRecording`, load-recording.ts).
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
  // Every OpenF1 REST call made (discovery, meetings, entry list, the
  // rotation poll), and the new rows / errors it produced, since the last
  // takeStats() call — feeds main.ts's per-minute composed line. Discovery
  // and the entry-list fetches count into these through `countStat`, so
  // there is one set of counters and one takeStats().
  private stats: RestLaneStats = { polls: 0, rows: 0, errors: 0, unjoined: 0 };

  // Rows recorded (via onRecorded, i.e. written into the jsonl recording) for
  // the currently followed session only — reset when a NEW session is
  // selected, reported once in the closed-recording log line at window
  // close.
  private followedRecordedRows = 0;

  private normalizer = new LiveNormalizer();
  private session: RawRecord | null = null;
  private sessionKey: number | null = null;
  private rotationIndex = 0;

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
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 2200;
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 60_000;
    this.onSessionSelected = opts.onSessionSelected;
    this.onRecordedCallback = opts.onRecorded;
    this.liveLogDir = opts.liveLogDir ?? "./live-logs";
    this.log = opts.onLog ?? ((): void => {});
    this.discovery = new SessionDiscovery({
      fetcher: this.fetcher,
      year: opts.year ?? new Date().getUTCFullYear(),
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
    const refreshed = await this.discovery.refreshSessions(nowMs);
    if (refreshed === null) return { sessionCount: 0, live: this.sessionKey !== null };
    const { rows, upserted } = refreshed;

    // The one-drivers-fetch-per-tick rule holds here too: a session
    // discovered inside its live window fetches its entry list at selection,
    // and Friday's meeting-wide fetch then waits for the next tick.
    const selectionFetched = await this.ensureLiveSession(rows, nowMs, upserted);

    // Friday: checked on every discovery tick — this is the idle (60s)
    // loop's own extra fetch, not competing with the rotation budget (there
    // is no rotation while idle).
    if (!selectionFetched) await this.entryList.checkFridayFetch(this.discovery.sessions(), nowMs);

    // After ensureLiveSession, so a session selected THIS tick is already
    // this.session/this.sessionKey — see SessionDiscovery's
    // recordFollowedMeetingRow for why this can't run any earlier.
    await this.discovery.recordFollowedMeetingRow(this.session, this.sessionKey);

    return { sessionCount: rows.length, live: this.sessionKey !== null };
  }

  /**
   * The `onRecorded` callback handed to every `enqueueRows`/
   * `enqueueDriverRows` call this lane makes, and also called directly
   * for the followed session's own `meetings` row (never queued, so it
   * never goes through `enqueueRows`). Counts a successfully recorded row
   * toward the closed-recording log line's `rows=<n>` when it belongs to
   * the currently followed session — the recorder itself keeps no count
   * (apps/ingest/src/openf1/recorder.ts), so the lane is the only place
   * that knows how many rows it forwarded. A rejected recording attempt is
   * logged at error level with the endpoint as a field and swallowed here:
   * the row is already queued (or, for `meetings`, was never meant to be)
   * regardless of whether it was ever written to disk, and one failed
   * write must not stop the lane.
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
      this.followedRecordedRows = 0;
      this.log(
        `rest: following session_key=${key} (${String(live["country_name"] ?? "?")})`,
      );
      // Once per newly-selected session — NOT on every discovery tick like
      // onSession: recorder.writeSession() running from onSession would
      // re-stamp session.json for every session of the year every 60s while
      // nothing is live.
      await this.onSessionSelected?.(live, nowMs);

      // The entry list's selection fetch belongs to this new session: the
      // fetches reset their retry state and attempt it immediately. Returns
      // whether it fetched, charging the tick's one-drivers-fetch budget.
      return this.entryList.onSessionSelected(key, nowMs);
    }
    return false;
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

    // Budget rule: a due drivers fetch takes this tick's one
    // request instead of the rotation poll — `rotationIndex` is left
    // untouched so the rotation resumes at the same endpoint next tick,
    // nothing is skipped.
    if (await this.entryList.runDue(this.session, this.discovery.sessions(), nowMs)) {
      return { endpoint: "drivers", rows: 0, newRows: 0, malformed: 0 };
    }

    // The idle discovery loop is off while live; refresh the sessions
    // snapshot on its cadence as this tick's one request, so a late upsert
    // (a race session that failed while FP1 went live) becomes known and
    // Friday's retry can fire on a later tick.
    if (this.discovery.sessionsRefreshDue(nowMs)) {
      await this.discovery.refreshSessions(nowMs);
      // Already following (pollOnce only runs while live) — this covers a
      // meetings row that becomes available on a later tick than
      // selection (e.g. this tick's fetch is the first to succeed).
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

  /** Thin wrapper around the free `enqueueRows()`, which now records through `onRecorded` itself — once per call, only when there's something new. */
  private async enqueueAndRecord(
    endpoint: string,
    sessionKey: number,
    rows: RawRecord[],
  ): Promise<{ newRows: number; malformed: number }> {
    const result = await enqueueRows(this.normalizer, this.queue, endpoint, sessionKey, rows, this.recordRows);
    this.countStat("unjoined", result.unjoined);
    return { newRows: result.newRows, malformed: result.malformed };
  }

  /**
   * `enqueueDriverRows`, which now records through `onRecorded` itself —
   * once per session_key group that wrote something, so a real fetched
   * entry list is recorded exactly like the static fallback and every
   * rotation poll. Rows naming a session not yet upserted are dropped (see
   * `knownSessionKeys`).
   */
  private async enqueueAndRecordDrivers(rows: RawRecord[], expectedSessionKey: number | null): Promise<EnqueueDriverRowsResult> {
    const result = await enqueueDriverRows(
      this.normalizer,
      this.queue,
      rows,
      expectedSessionKey,
      (key) => this.discovery.isKnownSession(key),
      this.recordRows,
    );
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
