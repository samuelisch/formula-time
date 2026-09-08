// ONE in-process queue (issue deliverable 3, HLD §7 single writer): both
// lanes (REST here, MQTT in T6) push onto it; the writer drains it in
// arrival order through the one connection, so `seq` order equals commit
// order.

export class EventQueue<T> {
  private readonly items: T[] = [];

  public push(item: T): void {
    this.items.push(item);
  }

  public pushAll(items: readonly T[]): void {
    for (const item of items) this.items.push(item);
  }

  /** Removes and returns up to `max` items, oldest first (FIFO). */
  public drain(max: number): T[] {
    return this.items.splice(0, max);
  }

  public get size(): number {
    return this.items.length;
  }

  public isEmpty(): boolean {
    return this.items.length === 0;
  }
}
