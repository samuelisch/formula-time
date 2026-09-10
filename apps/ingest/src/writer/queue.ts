// ONE in-process queue (HLD §7 single writer): both
// lanes (REST and MQTT) push onto it; the writer drains it in
// arrival order through the one connection, so `seq` order equals commit
// order.

export interface EventQueueOptions {
  /**
   * Hard cap on queue length: an unbounded queue
   * behind a stuck writer grows without bound. Default 200,000 rows.
   * Beyond it, `push`/`pushAll` drop the newest row and count it —
   * `takeDropped()` is how the writer reads and clears that count.
   */
  maxQueued?: number;
}

const DEFAULT_MAX_QUEUED = 200_000;

export class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly maxQueued: number;
  private droppedSinceLastTake = 0;

  public constructor(opts: EventQueueOptions = {}) {
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  /** Drops the row (and counts it) once the queue is at its cap. */
  public push(item: T): void {
    if (this.items.length >= this.maxQueued) {
      this.droppedSinceLastTake += 1;
      return;
    }
    this.items.push(item);
  }

  public pushAll(items: readonly T[]): void {
    for (const item of items) this.push(item);
  }

  /** Removes and returns up to `max` items, oldest first (FIFO). */
  public drain(max: number): T[] {
    return this.items.splice(0, max);
  }

  /**
   * Puts `items` back at the front, in their given order. For a batch that
   * was just `drain()`ed (it was the head) and failed to write, this
   * restores arrival order exactly — the next drain retries the same batch.
   * Bypasses the cap: these rows were already admitted, not new arrivals.
   */
  public requeueFront(items: readonly T[]): void {
    this.items.unshift(...items);
  }

  public get size(): number {
    return this.items.length;
  }

  public isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Drops every item currently queued, returning how many. After a caller
   * decides a stuck batch (still at the front from `requeueFront`) is never
   * going to write — `EventWriter`'s `drainAll()` gave up on it — the queue
   * must not carry that batch into whatever the caller does next, or it
   * poisons the next thing drained.
   */
  public clear(): number {
    const count = this.items.length;
    this.items.length = 0;
    return count;
  }

  /** Rows dropped (cap hit) since the last call. Reading resets the count to 0. */
  public takeDropped(): number {
    const count = this.droppedSinceLastTake;
    this.droppedSinceLastTake = 0;
    return count;
  }
}
