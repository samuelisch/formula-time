import { describe, expect, test } from "vitest";

import { EventQueue } from "./queue.js";

describe("EventQueue", () => {
  test("drain preserves arrival order (FIFO)", () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect(queue.drain(10)).toEqual([1, 2, 3]);
  });

  test("drain splits a large push into batches at the requested max", () => {
    const queue = new EventQueue<number>();
    queue.pushAll(Array.from({ length: 250 }, (_, i) => i));

    const first = queue.drain(100);
    const second = queue.drain(100);
    const third = queue.drain(100);

    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(third).toHaveLength(50);
    expect(first[0]).toBe(0);
    expect(second[0]).toBe(100);
    expect(third[0]).toBe(200);
    expect(queue.isEmpty()).toBe(true);
  });

  test("draining more than available returns what's there and empties the queue", () => {
    const queue = new EventQueue<number>();
    queue.pushAll([1, 2]);
    expect(queue.drain(100)).toEqual([1, 2]);
    expect(queue.drain(100)).toEqual([]);
  });

  test("size and isEmpty reflect pushes and drains", () => {
    const queue = new EventQueue<number>();
    expect(queue.isEmpty()).toBe(true);
    queue.push(1);
    expect(queue.size).toBe(1);
    expect(queue.isEmpty()).toBe(false);
    queue.drain(1);
    expect(queue.isEmpty()).toBe(true);
  });

  test("interleaved pushes from two lanes still drain in arrival order", () => {
    const queue = new EventQueue<string>();
    queue.push("rest:1");
    queue.push("mqtt:1");
    queue.push("rest:2");
    expect(queue.drain(10)).toEqual(["rest:1", "mqtt:1", "rest:2"]);
  });

  test("clear() empties the queue and returns how many items it dropped (round 1 fix, issue #71)", () => {
    const queue = new EventQueue<number>();
    queue.pushAll([1, 2, 3]);

    expect(queue.clear()).toBe(3);
    expect(queue.isEmpty()).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.clear()).toBe(0); // already empty
  });

  test("requeueFront puts a failed batch back at the head, in its original order", () => {
    const queue = new EventQueue<number>();
    queue.pushAll([3, 4, 5]);
    const batch = queue.drain(2); // [3, 4] — as if a write of this batch failed
    expect(batch).toEqual([3, 4]);

    queue.requeueFront(batch);

    expect(queue.drain(10)).toEqual([3, 4, 5]);
  });
});

describe("EventQueue cap (maxQueued)", () => {
  test("push beyond the cap drops the newest row and holds the length at the cap", () => {
    const queue = new EventQueue<number>({ maxQueued: 3 });
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.push(4); // dropped: at cap
    queue.push(5); // dropped: at cap

    expect(queue.size).toBe(3);
    expect(queue.drain(10)).toEqual([1, 2, 3]); // the newest rows (4, 5) never landed
  });

  test("pushAll respects the same cap, dropping whichever items land beyond it", () => {
    const queue = new EventQueue<number>({ maxQueued: 2 });
    queue.pushAll([1, 2, 3, 4]);

    expect(queue.size).toBe(2);
    expect(queue.drain(10)).toEqual([1, 2]);
  });

  test("takeDropped() counts drops and resets to 0 after being read", () => {
    const queue = new EventQueue<number>({ maxQueued: 1 });
    queue.push(1);
    queue.push(2); // dropped
    queue.push(3); // dropped

    expect(queue.takeDropped()).toBe(2);
    expect(queue.takeDropped()).toBe(0); // reset — nothing new dropped since

    queue.push(4); // still dropped: queue is full
    expect(queue.takeDropped()).toBe(1);
  });

  test("requeueFront bypasses the cap: rows already admitted are not re-dropped on a retry", () => {
    const queue = new EventQueue<number>({ maxQueued: 2 });
    queue.pushAll([1, 2]); // at cap
    const batch = queue.drain(2); // [1, 2] — as if a write failed
    queue.pushAll([3, 4]); // fills back up to the cap while the batch is "in flight"

    queue.requeueFront(batch); // the retry puts the failed batch back at the front

    expect(queue.size).toBe(4); // over the nominal cap, but nothing was lost
    expect(queue.takeDropped()).toBe(0);
    expect(queue.drain(10)).toEqual([1, 2, 3, 4]);
  });
});
