// The one writer: ONE Prisma client (`createDb(process.env.DATABASE_URL, {
// max: 1 })`, wired in main.ts) draining the ONE queue, inserting in arrival
// order in batches of up to 100 with `event.createMany({ data, skipDuplicates:
// true })` (issue deliverable 3). Because there is one connection, `seq`
// order equals commit order (HLD §7 single writer). Never patch, never
// update an event row — apps/ingest/AGENTS.md.

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
        payload: unknown;
      }>;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export interface DrainResult {
  inserted: number;
  skipped: number;
}

const DEFAULT_BATCH_SIZE = 100;

export class EventWriter {
  private readonly batchSize: number;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly db: EventWriterDb,
    private readonly queue: EventQueue<QueueItem>,
    opts: { batchSize?: number } = {},
  ) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Drains up to one batch. Returns `null` when the queue was empty (no DB call). */
  public async drainOnce(): Promise<DrainResult | null> {
    const batch = this.queue.drain(this.batchSize);
    if (batch.length === 0) return null;
    const data = batch.map((item) => ({
      eventId: item.eventId,
      sessionKey: item.sessionKey,
      endpoint: item.endpoint,
      sourceTime: item.sourceTime,
      payload: item.payload,
    }));
    const result = await this.db.event.createMany({ data, skipDuplicates: true });
    return { inserted: result.count, skipped: batch.length - result.count };
  }

  /** Drains batch after batch until the queue is empty. Used by `stop()` and tests. */
  public async drainAll(): Promise<DrainResult> {
    let inserted = 0;
    let skipped = 0;
    let result: DrainResult | null;
    while ((result = await this.drainOnce()) !== null) {
      inserted += result.inserted;
      skipped += result.skipped;
      if (typeof console !== "undefined" && result.inserted + result.skipped > 0) {
        console.log(`writer: batch inserted=${result.inserted} skipped=${result.skipped}`);
      }
    }
    return { inserted, skipped };
  }

  /** Production loop: polls the queue every `intervalMs` until `stop()`. */
  public run(intervalMs = 250): void {
    this.stopped = false;
    const tick = (): void => {
      if (this.stopped) return;
      void this.drainOnce()
        .then((result) => {
          if (result && (result.inserted > 0 || result.skipped > 0)) {
            console.log(`writer: batch inserted=${result.inserted} skipped=${result.skipped}`);
          }
        })
        .catch((error: unknown) => {
          console.error(`writer: batch failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
        });
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  /** SIGTERM path: stop scheduling new ticks, drain what's left, then resolve. */
  public async stop(): Promise<DrainResult> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.drainAll();
  }
}
