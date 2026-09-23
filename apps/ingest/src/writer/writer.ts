// The one writer: ONE Prisma client (`createDb(process.env.DATABASE_URL, {
// max: 1 })`, wired in main.ts) draining the ONE queue, inserting in arrival
// order in batches of up to 100 with `event.createMany({ data, skipDuplicates:
// true })`. Because there is one connection, `seq` order equals commit
// order (HLD §7 single writer). Ingest never updates an `events` row
// (ADR-0007 §1).

import type { Prisma } from "@formula-time/db";

import type { LaneLog } from "../log.js";
import type { QueueItem } from "../openf1/types.js";
import type { EventQueue } from "./queue.js";

/** The slice of the Prisma client the writer needs — real client or a fake. */
export interface EventWriterDb {
  event: {
    createMany(args: {
      data: Array<{
        eventId: string;
        sessionKey: bigint;
        endpoint: string;
        sourceTime: Date | null;
        payload: Prisma.InputJsonValue;
      }>;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export interface DrainResult {
  inserted: number;
  skipped: number;
}

/** Counters `takeStats()` returns and resets — feeds `main.ts`'s per-minute `ingest: last 60s` line. */
export interface WriterStats {
  inserted: number;
  skipped: number;
  failures: number;
}

const DEFAULT_BATCH_SIZE = 100;

/**
 * `run()`'s retry delay after `consecutiveFailures` consecutive failures:
 * `baseMs` doubling each time, capped at `maxMs`. `consecutiveFailures <= 0`
 * (the healthy path) returns `baseMs` itself unchanged.
 */
export function backoffDelayMs(baseMs: number, consecutiveFailures: number, maxMs: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** consecutiveFailures, maxMs);
}

export class EventWriter {
  private readonly batchSize: number;
  // Count-carrying lines route through here (main.ts wires it to the
  // structured logger with lane="writer"); no-op when the caller doesn't
  // care, so tests aren't forced to supply one.
  private readonly log: LaneLog;
  // Inserted/skipped/failures since the last takeStats() call — feeds
  // main.ts's per-minute composed line; reset on read, not on every batch.
  private statsInserted = 0;
  private statsSkipped = 0;
  private statsFailures = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  // Tracks the drain currently in flight (awaiting `db.event.createMany`) so
  // `stop()` can wait for it instead of returning while an insert is still
  // running — otherwise SIGTERM can see an empty queue (the batch was
  // already spliced off by `drain()`) and exit before that insert commits.
  // Resolves to the batch's result (or `null` on failure) so `stop()` can
  // fold it into the total it reports.
  private currentDrain: Promise<DrainResult | null> | null = null;

  public constructor(
    private readonly db: EventWriterDb,
    private readonly queue: EventQueue<QueueItem>,
    opts: { batchSize?: number; log?: LaneLog } = {},
  ) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.log = opts.log ?? ((): void => {});
  }

  /** Inserted/skipped/failures since the previous call, then reset to zero. */
  public takeStats(): WriterStats {
    const stats: WriterStats = {
      inserted: this.statsInserted,
      skipped: this.statsSkipped,
      failures: this.statsFailures,
    };
    this.statsInserted = 0;
    this.statsSkipped = 0;
    this.statsFailures = 0;
    return stats;
  }

  /**
   * Drains up to one batch; `null` means the queue was empty. On a
   * rejected `createMany`, the batch goes back to the queue's front (it
   * was the head) for the next drain to retry, and the error rethrows.
   */
  public async drainOnce(): Promise<DrainResult | null> {
    // The queue's hard cap: if it's been dropping
    // the newest rows because a stuck writer let it grow unbounded, log
    // that once per batch rather than losing rows silently.
    const dropped = this.queue.takeDropped();
    if (dropped > 0) {
      this.log(`writer: queue at capacity, dropped ${dropped} rows since the last batch`, {
        level: "error",
        fields: { dropped },
      });
    }
    const batch = this.queue.drain(this.batchSize);
    if (batch.length === 0) return null;
    const data = batch.map((item) => ({
      eventId: item.eventId,
      sessionKey: item.sessionKey,
      endpoint: item.endpoint,
      sourceTime: item.sourceTime,
      // RawRecord is JSON.parse'd from the OpenF1 response or a recorded
      // capture, so it is structurally a Prisma.InputJsonValue even though
      // `Record<string, unknown>` doesn't say so to the type checker.
      payload: item.payload as Prisma.InputJsonValue,
    }));
    try {
      const result = await this.db.event.createMany({ data, skipDuplicates: true });
      this.statsInserted += result.count;
      this.statsSkipped += batch.length - result.count;
      return { inserted: result.count, skipped: batch.length - result.count };
    } catch (error) {
      this.queue.requeueFront(batch);
      this.statsFailures += 1;
      this.log(
        `writer: batch of ${batch.length} failed, requeued: ${error instanceof Error ? error.message : String(error)}`,
        { level: "error", fields: { failures: 1 } },
      );
      throw error;
    }
  }

  // A dead database must not hang SIGTERM forever: give up after this many
  // consecutive failures of the same (requeued) batch.
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  /**
   * Drains batch after batch until the queue is empty, retrying a failed
   * batch (it's requeued by `drainOnce()`) up to `MAX_CONSECUTIVE_FAILURES`
   * times in a row before giving up and returning — used by `stop()` and
   * tests.
   */
  public async drainAll(): Promise<DrainResult> {
    let inserted = 0;
    let skipped = 0;
    let consecutiveFailures = 0;
    while (!this.queue.isEmpty()) {
      let result: DrainResult | null;
      try {
        result = await this.drainOnce();
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= EventWriter.MAX_CONSECUTIVE_FAILURES) {
          this.log(`writer: giving up after ${consecutiveFailures} consecutive failures, dropped=${this.queue.size}`, {
            level: "error",
          });
          return { inserted, skipped };
        }
        continue;
      }
      consecutiveFailures = 0;
      if (result === null) break;
      inserted += result.inserted;
      skipped += result.skipped;
      if (result.inserted + result.skipped > 0) {
        this.log(`writer: batch inserted=${result.inserted} skipped=${result.skipped}`);
      }
    }
    return { inserted, skipped };
  }

  // The retry backoff after consecutive run() failures: 250ms doubling to a
  // 30s cap — a dead database must not be hammered
  // at the steady polling cadence forever.
  private static readonly BACKOFF_BASE_MS = 250;
  private static readonly BACKOFF_MAX_MS = 30_000;
  private consecutiveRunFailures = 0;

  /** Production loop: polls the queue every `intervalMs` until `stop()`, backing off on failures. */
  public run(intervalMs = 250): void {
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      const drainPromise = this.drainOnce()
        .then((result) => {
          this.consecutiveRunFailures = 0;
          if (result && (result.inserted > 0 || result.skipped > 0)) {
            this.log(`writer: batch inserted=${result.inserted} skipped=${result.skipped}`);
          }
          return result;
        })
        .catch(() => {
          // drainOnce() already logged the failure (with the batch size)
          // and requeued the batch at the front; the next tick retries it,
          // after backing off, at a delay based on the count below.
          this.consecutiveRunFailures += 1;
          this.log(`writer: ${this.consecutiveRunFailures} consecutive failures, queue depth=${this.queue.size}`, {
            level: "error",
          });
          return null;
        })
        .finally(() => {
          this.currentDrain = null;
          if (!this.stopped) {
            // The steady `intervalMs` cadence while healthy; once failing,
            // the fixed 250ms-doubling-to-30s backoff takes over regardless
            // of what `intervalMs` was configured to.
            const delay =
              this.consecutiveRunFailures > 0
                ? backoffDelayMs(EventWriter.BACKOFF_BASE_MS, this.consecutiveRunFailures, EventWriter.BACKOFF_MAX_MS)
                : intervalMs;
            this.timer = setTimeout(tick, delay);
          }
        });
      this.currentDrain = drainPromise;
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  /**
   * SIGTERM path: stop scheduling new ticks, wait for any drain already in
   * flight to finish, then drain whatever is left (with the retry/give-up
   * policy in `drainAll()`).
   */
  public async stop(): Promise<DrainResult> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const inFlight = this.currentDrain ? await this.currentDrain : null;
    const rest = await this.drainAll();
    return {
      inserted: (inFlight?.inserted ?? 0) + rest.inserted,
      skipped: (inFlight?.skipped ?? 0) + rest.skipped,
    };
  }
}
