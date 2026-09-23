// The authority (ADR-0001 §1, HLD §7): folds `events` for one live
// session into one RaceState. Exactly one instance runs per process. The
// late-commit detector exists because `seq` is assigned at insert but a
// row is visible only at commit, so two writer connections can make a
// later seq visible before an earlier one; ingest uses one connection
// (ADR-0005), so this should never actually fire. See README: One tick.
import type { Session } from "@formula-time/db";
import {
  createInitialState,
  RaceStateReducer,
  sessionToWire,
  type RaceEvent,
  type RaceState,
  type RawRecord,
} from "@formula-time/domain";

import { toRaceEvent, type EventRow, type EventSource } from "./event-source.js";

export type ProjectorLog = (msg: string, fields?: Record<string, unknown>) => void;

export interface ProjectorOptions {
  source: EventSource;
  session: Session;
  /** Poll interval, ms. Default 250 (HLD §7 "Cursor"). */
  tickMs?: number;
  /** Rows per readAfter call. A full batch means "more to read" (no publish yet). */
  batchLimit?: number;
  /** Run the late-commit detector every Nth tick. */
  detectorEveryTicks?: number;
  /** How far behind the cursor the detector's window looks. */
  detectorWindow?: bigint;
  log: ProjectorLog;
}

// `events`: the RaceEvent rows this tick applied, in seq order; `[]` on a
// tick that applied nothing new, and on any catch-up or rebuild tick
// (ADR-0014). `rebuilt` is true only on the tick where the late-commit
// detector's rebuild lands. See README: One tick.
export type ProjectorSubscriber = (
  state: RaceState,
  cursor: bigint,
  events: RaceEvent[],
  rebuilt: boolean,
) => void;

const DEFAULT_TICK_MS = 250;
const DEFAULT_BATCH_LIMIT = 5000;
const DEFAULT_DETECTOR_EVERY_TICKS = 40;
const DEFAULT_DETECTOR_WINDOW = 2000n;

// BigInt does not survive JSON.stringify (the fan-out's one-serialize-per-push
// rule): session_key travels as a string, via the shared sessionToWire
// mapping (ADR-0041) also used by the exporter, so the two cannot disagree.
// `RaceState.session` stays a `RawRecord` (the reducer accepts any session
// metadata shape); `SessionWire` has no index signature, so the cast is the
// same widening `sessionAsRawRecord`'s own object literal did before it.
function sessionAsRawRecord(session: Session): RawRecord {
  return sessionToWire(session) as unknown as RawRecord;
}

export class RaceStateProjector {
  private readonly source: EventSource;
  private session: Session;
  private readonly tickMs: number;
  private readonly batchLimit: number;
  private readonly detectorEveryTicks: number;
  private readonly detectorWindow: bigint;
  private readonly log: ProjectorLog;

  private reducer: RaceStateReducer;
  private cursor = 0n;
  private caughtUp = false;
  private appliedIds = new Set<string>();
  private readonly subscribers = new Set<ProjectorSubscriber>();

  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private foldStartedAt = 0;
  private tickChain: Promise<void> = Promise.resolve();

  // Bumped on every start(): a tick mid-await when stop() runs doesn't stop
  // being mid-await -- `stopped` alone flips back to false on a later
  // start(), so that stale tick would resume, see itself as "running"
  // again, and call scheduleTick(), leaving two independent timer chains
  // ticking in parallel. Each scheduled tick captures the generation it
  // was scheduled under and bails if it does not match the current one.
  private generation = 0;

  public constructor(opts: ProjectorOptions) {
    this.source = opts.source;
    this.session = opts.session;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
    this.detectorEveryTicks = opts.detectorEveryTicks ?? DEFAULT_DETECTOR_EVERY_TICKS;
    this.detectorWindow = opts.detectorWindow ?? DEFAULT_DETECTOR_WINDOW;
    this.log = opts.log;
    this.reducer = this.freshReducer();
  }

  private freshReducer(): RaceStateReducer {
    return new RaceStateReducer(
      createInitialState({ sessions: [sessionAsRawRecord(this.session)], drivers: [] }),
    );
  }

  public start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.generation += 1;
    this.scheduleTick(0, this.generation);
  }

  public stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public subscribe(fn: ProjectorSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  public snapshot(): RaceState {
    return this.reducer.snapshot();
  }

  public status(): { sessionKey: bigint; cursor: bigint; caughtUp: boolean } {
    return { sessionKey: this.session.sessionKey, cursor: this.cursor, caughtUp: this.caughtUp };
  }

  /** The session row this projector currently folds against -- read this at
   * push time rather than closing over the row from wiring time, since the
   * row can change (status, total_laps, ...) without a session-key change. */
  public currentSession(): Session {
    return this.session;
  }

  // The session row is metadata the fold carries, refreshed on every
  // lifecycle check: no event, no seq. Replaces the row and updates the
  // reducer's state.session in place, then publishes immediately with
  // events: [] so a status flip reaches viewers within a tick rather than
  // at the next event.
  public updateSession(session: Session): void {
    this.session = session;
    this.reducer.setSession(sessionAsRawRecord(session));
    this.publish([]);
  }

  private scheduleTick(delayMs: number, generation: number): void {
    if (this.stopped || generation !== this.generation) {
      return;
    }
    this.timer = setTimeout(() => {
      // Never overlapping ticks: chain onto the previous tick's promise
      // rather than firing a concurrent one if a tick somehow outran its
      // own interval.
      this.tickChain = this.tickChain.then(() => this.tick(generation));
    }, delayMs);
  }

  private async tick(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) {
      return;
    }

    this.tickCount += 1;
    if (!this.caughtUp) {
      this.foldStartedAt = Date.now();
    }

    // A rejected read must not stall the tick chain forever or crash the
    // process: scheduleTick chains with `.then()` and no `.catch()`, so an
    // uncaught rejection here would leave every future tick unscheduled.
    // Catch, log, retry on schedule -- cursor and state are left exactly
    // as they were (a rejected read applies no row).
    try {
      if (this.tickCount % this.detectorEveryTicks === 0) {
        await this.runDetector();
        if (this.stopped || generation !== this.generation) {
          return;
        }
      }

      let totalApplied = 0;
      let rows: EventRow[];
      const appliedThisTick: EventRow[] = [];
      do {
        rows = await this.source.readAfter(this.session.sessionKey, this.cursor, this.batchLimit);
        if (this.stopped || generation !== this.generation) {
          return;
        }
        for (const row of rows) {
          this.applyRow(row);
          appliedThisTick.push(row);
          totalApplied += 1;
        }
      } while (rows.length === this.batchLimit);

      const justCaughtUp = !this.caughtUp;
      if (justCaughtUp) {
        this.caughtUp = true;
        this.log("fold complete", {
          rows: totalApplied,
          ms: Date.now() - this.foldStartedAt,
          cursor: this.cursor.toString(),
        });
      }

      if (totalApplied > 0 || justCaughtUp) {
        // The tick that first reaches caught-up read the historical
        // backlog into `appliedThisTick`, not new rows for a client's
        // timeline -- a client already gets that history from its own
        // paged backfill. Same as the rebuild path below: publish
        // `events: []`, never the re-folded backlog.
        this.publish(justCaughtUp ? [] : appliedThisTick.map(toRaceEvent));
      }
    } catch (err) {
      this.log("projector tick failed", {
        level: "error",
        error: err instanceof Error ? err.message : String(err),
        cursor: this.cursor.toString(),
      });
    }

    this.scheduleTick(this.tickMs, generation);
  }

  private applyRow(row: EventRow): void {
    this.reducer.apply(toRaceEvent(row));
    this.appliedIds.add(row.eventId);
    this.cursor = row.seq;
  }

  private publish(events: RaceEvent[], rebuilt = false): void {
    const state = this.reducer.snapshot();
    for (const fn of this.subscribers) {
      fn(state, this.cursor, events, rebuilt);
    }
  }

  private async runDetector(): Promise<void> {
    const from = this.cursor > this.detectorWindow ? this.cursor - this.detectorWindow : 0n;
    const window = await this.source.readWindow(this.session.sessionKey, from, this.cursor);
    const lateRow = window.find((row) => !this.appliedIds.has(row.eventId));
    if (lateRow === undefined) {
      return;
    }

    this.log("late commit detected", {
      level: "error",
      seq: lateRow.seq.toString(),
      event_id: lateRow.eventId,
      cursor: this.cursor.toString(),
    });

    // Never patch in place (HLD §7 "Fold"): re-fold into locals and swap
    // them into `this.*` only once the rebuild is fully caught up, so a
    // live join in between still gets the last-known-good state, not an
    // empty one. A failed rebuild retries on the next detector pass,
    // since `appliedIds`/`cursor` are left untouched and the same late
    // row is found again.
    const localReducer = this.freshReducer();
    let localCursor = 0n;
    const localAppliedIds = new Set<string>();

    try {
      let rows: EventRow[];
      do {
        rows = await this.source.readAfter(this.session.sessionKey, localCursor, this.batchLimit);
        for (const row of rows) {
          localReducer.apply(toRaceEvent(row));
          localAppliedIds.add(row.eventId);
          localCursor = row.seq;
        }
      } while (rows.length === this.batchLimit);
    } catch (err) {
      this.log("rebuild failed, keeping previous state", {
        level: "error",
        error: err instanceof Error ? err.message : String(err),
        cursor: this.cursor.toString(),
      });
      return;
    }

    // The session row is metadata the projector owns, not any one reducer
    // instance: `this.session` may have moved (updateSession()) while this
    // rebuild was awaiting its reads, and `freshReducer()` above baked in
    // whatever row was current before those awaits. Re-apply the current
    // row right before the swap so the rebuild can never revert a refresh
    // that landed while it was in flight.
    localReducer.setSession(sessionAsRawRecord(this.session));
    this.reducer = localReducer;
    this.cursor = localCursor;
    this.appliedIds = localAppliedIds;
    // A rebuild re-folds rows already accounted for (plus the late one) --
    // not new events for a client's timeline to append. Push
    // `events: [], rebuilt: true` so the client discards its timeline and
    // backfills from the paged log route instead of trying to reconcile it.
    this.publish([], true);
  }
}
