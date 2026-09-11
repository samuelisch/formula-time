import { describe, expect, test, vi } from "vitest";

import type { QueueItem } from "../openf1/types.js";
import { EventQueue } from "./queue.js";
import type { EventWriterDb } from "./writer.js";
import { EventWriter, backoffDelayMs } from "./writer.js";

// In-memory fake standing in for the real Prisma client: mirrors
// `event.createMany({ data, skipDuplicates: true })` against a Set keyed by
// eventId, same as the real `event_id` primary key / `ON CONFLICT DO NOTHING`.
function fakeDb(): EventWriterDb & { rows: Map<string, unknown>; insertOrder: string[] } {
  const rows = new Map<string, unknown>();
  const insertOrder: string[] = [];
  return {
    rows,
    insertOrder,
    event: {
      async createMany(args) {
        let count = 0;
        for (const row of args.data) {
          if (rows.has(row.eventId)) continue;
          rows.set(row.eventId, row);
          insertOrder.push(row.eventId);
          count += 1;
        }
        return { count };
      },
    },
  };
}

function item(eventId: string, endpoint = "position"): QueueItem {
  return { eventId, sessionKey: 1n, endpoint, sourceTime: null, payload: { eventId } };
}

describe("EventWriter.drainOnce", () => {
  test("empty queue -> null, no db call", async () => {
    const db = fakeDb();
    const spy = vi.spyOn(db.event, "createMany");
    const writer = new EventWriter(db, new EventQueue<QueueItem>());

    expect(await writer.drainOnce()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test("inserts a batch, reporting inserted vs skipped", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    queue.push(item("b"));
    const writer = new EventWriter(db, queue);

    const result = await writer.drainOnce();
    expect(result).toEqual({ inserted: 2, skipped: 0 });
  });

  test("the same batch written twice: second write skips duplicates", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    queue.push(item("b"));
    const writer = new EventWriter(db, queue);
    await writer.drainOnce();

    queue.push(item("a"));
    queue.push(item("b"));
    const second = await writer.drainOnce();
    expect(second).toEqual({ inserted: 0, skipped: 2 });
    expect(db.rows.size).toBe(2);
  });
});

describe("EventWriter batch splitting", () => {
  test("splits at 100 by default", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    for (let i = 0; i < 250; i++) queue.push(item(`e${i}`));
    const writer = new EventWriter(db, queue);

    const first = await writer.drainOnce();
    const second = await writer.drainOnce();
    const third = await writer.drainOnce();
    const fourth = await writer.drainOnce();

    expect(first).toEqual({ inserted: 100, skipped: 0 });
    expect(second).toEqual({ inserted: 100, skipped: 0 });
    expect(third).toEqual({ inserted: 50, skipped: 0 });
    expect(fourth).toBeNull();
  });

  test("a custom batch size is honored", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    for (let i = 0; i < 5; i++) queue.push(item(`e${i}`));
    const writer = new EventWriter(db, queue, { batchSize: 2 });

    expect(await writer.drainOnce()).toEqual({ inserted: 2, skipped: 0 });
    expect(await writer.drainOnce()).toEqual({ inserted: 2, skipped: 0 });
    expect(await writer.drainOnce()).toEqual({ inserted: 1, skipped: 0 });
  });
});

describe("EventWriter.drainAll / stop", () => {
  test("drainAll drains every batch in arrival order and totals across them", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    for (let i = 0; i < 120; i++) queue.push(item(`e${i}`));
    const writer = new EventWriter(db, queue);

    const totals = await writer.drainAll();
    expect(totals).toEqual({ inserted: 120, skipped: 0 });
    expect(db.insertOrder).toEqual(Array.from({ length: 120 }, (_, i) => `e${i}`));
    expect(queue.isEmpty()).toBe(true);
  });

  test("drainAll calls the supplied log once per non-empty batch, with the inserted/skipped counts", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    for (let i = 0; i < 120; i++) queue.push(item(`e${i}`));
    const lines: string[] = [];
    const writer = new EventWriter(db, queue, { log: (line) => lines.push(line) });

    await writer.drainAll();

    expect(lines).toEqual([
      "writer: batch inserted=100 skipped=0",
      "writer: batch inserted=20 skipped=0",
    ]);
  });

  test("stop() drains what's left and further drainOnce calls see an empty queue", async () => {
    const db = fakeDb();
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    queue.push(item("b"));
    const writer = new EventWriter(db, queue);

    const totals = await writer.stop();
    expect(totals).toEqual({ inserted: 2, skipped: 0 });
    expect(await writer.drainOnce()).toBeNull();
  });

  test("stop() waits for a drain already in flight (from run()) before resolving, and its rows are counted", async () => {
    const rows = new Map<string, unknown>();
    let resolveCreateMany: (() => void) | null = null;
    let capturedData: Array<{ eventId: string }> | null = null;
    const db: EventWriterDb = {
      event: {
        createMany: (args) =>
          new Promise((resolve) => {
            capturedData = args.data;
            resolveCreateMany = () => {
              let count = 0;
              for (const row of args.data) {
                if (rows.has(row.eventId)) continue;
                rows.set(row.eventId, row);
                count += 1;
              }
              resolve({ count });
            };
          }),
      },
    };
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    const writer = new EventWriter(db, queue);

    writer.run(5); // fast tick so the in-flight createMany starts quickly
    await waitUntil(() => resolveCreateMany !== null);
    expect(capturedData).toEqual([expect.objectContaining({ eventId: "a" })]);

    let stopped = false;
    const stopPromise = writer.stop().then((totals) => {
      stopped = true;
      return totals;
    });

    // The insert is still pending: stop() must not have resolved yet.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);

    resolveCreateMany!();
    const totals = await stopPromise;

    expect(stopped).toBe(true);
    expect(totals.inserted).toBe(1); // the in-flight batch's row is counted
  });
});

describe("EventWriter retry on a failed write", () => {
  test("a rejected createMany requeues the batch at the front; the retry inserts every row in original arrival order", async () => {
    const insertOrder: string[] = [];
    let callCount = 0;
    const db: EventWriterDb = {
      event: {
        async createMany(args) {
          callCount += 1;
          if (callCount === 1) throw new Error("connection reset");
          for (const row of args.data) insertOrder.push(row.eventId);
          return { count: args.data.length };
        },
      },
    };
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    queue.push(item("b"));
    const writer = new EventWriter(db, queue);

    await expect(writer.drainOnce()).rejects.toThrow("connection reset");
    // Nothing lost: drainOnce() requeued the batch at the front.
    expect(queue.size).toBe(2);

    const result = await writer.drainOnce(); // retry: drains the requeued batch
    expect(result).toEqual({ inserted: 2, skipped: 0 });
    expect(insertOrder).toEqual(["a", "b"]);
  });

  test("drainAll gives up after 3 consecutive failures on a dead database and reports the dropped count", async () => {
    let calls = 0;
    const db: EventWriterDb = {
      event: {
        async createMany() {
          calls += 1;
          throw new Error("db down");
        },
      },
    };
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    queue.push(item("b"));
    const writer = new EventWriter(db, queue);

    const totals = await writer.drainAll();

    expect(totals).toEqual({ inserted: 0, skipped: 0 });
    expect(calls).toBe(3); // 3 consecutive failures of the same requeued batch, then give up
    expect(queue.size).toBe(2); // the batch is still there — dropped, not discarded
  });
});

describe("backoffDelayMs", () => {
  test("no failures yet -> the base delay, unchanged", () => {
    expect(backoffDelayMs(250, 0, 30_000)).toBe(250);
  });

  test("doubles with each consecutive failure", () => {
    expect(backoffDelayMs(250, 1, 30_000)).toBe(500);
    expect(backoffDelayMs(250, 2, 30_000)).toBe(1_000);
    expect(backoffDelayMs(250, 3, 30_000)).toBe(2_000);
    expect(backoffDelayMs(250, 6, 30_000)).toBe(16_000);
  });

  test("caps at maxMs", () => {
    expect(backoffDelayMs(250, 7, 30_000)).toBe(30_000); // 250*2^7 = 32,000 -> capped
    expect(backoffDelayMs(250, 20, 30_000)).toBe(30_000);
  });
});

describe("EventWriter.run() backs off on consecutive failures and resets on success", () => {
  test("a failure schedules the next tick at the 250ms-doubled backoff, not the steady interval; a success reverts to the steady interval", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let shouldFail = true;
    const db: EventWriterDb = {
      event: {
        async createMany() {
          if (shouldFail) throw new Error("db down");
          return { count: 1 };
        },
      },
    };
    const queue = new EventQueue<QueueItem>();
    queue.push(item("a"));
    const writer = new EventWriter(db, queue);

    writer.run(50); // a fast steady-state interval, distinct from any backoff value

    // tick 1 fails -> the NEXT tick is scheduled at the backoff for 1
    // consecutive failure (250ms base, doubled once) = 500ms, not 50ms.
    await waitUntil(() => setTimeoutSpy.mock.calls.some((c) => c[1] === 500), 2000);

    shouldFail = false;
    // that backoff tick succeeds -> the tick after THAT reverts to the
    // steady 50ms interval (the first 50ms call is run()'s initial
    // schedule, so two total means one more happened after the success).
    await waitUntil(() => setTimeoutSpy.mock.calls.filter((c) => c[1] === 50).length >= 2, 2000);

    await writer.stop();
    setTimeoutSpy.mockRestore();
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
