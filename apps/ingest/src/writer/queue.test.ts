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
});
