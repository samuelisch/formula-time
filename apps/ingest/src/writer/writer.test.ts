import { describe, expect, test, vi } from "vitest";

import type { QueueItem } from "../openf1/types.js";
import { EventQueue } from "./queue.js";
import type { EventWriterDb } from "./writer.js";
import { EventWriter } from "./writer.js";

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
});
