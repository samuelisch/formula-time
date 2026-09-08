import { describe, expect, it } from "vitest";
import { append, BUFFER_LIMITS, emptyBuffer, select, span } from "./buffer.ts";
import type { BufferedPush } from "./buffer.ts";

function push(at: number, raw = `raw-${at}`): BufferedPush {
  return { at, raw };
}

describe("emptyBuffer", () => {
  it("starts with no entries", () => {
    expect(emptyBuffer().entries).toEqual([]);
  });
});

describe("append", () => {
  it("keeps entries ascending by at", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(100));
    buffer = append(buffer, push(200));
    buffer = append(buffer, push(300));
    expect(buffer.entries.map((e) => e.at)).toEqual([100, 200, 300]);
  });

  it("clamps an at below the newest to the newest, preserving monotonic order", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(200));
    buffer = append(buffer, push(100, "late"));
    expect(buffer.entries.map((e) => e.at)).toEqual([200, 200]);
    expect(buffer.entries[1]?.raw).toBe("late");
  });

  it("evicts by age from the newest entry", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(0), { maxEntries: 600, maxAgeMs: 1000 });
    buffer = append(buffer, push(500), { maxEntries: 600, maxAgeMs: 1000 });
    buffer = append(buffer, push(1500), { maxEntries: 600, maxAgeMs: 1000 });
    // newest is 1500; anything older than 1500 - 1000 = 500 is evicted (exclusive of 500 itself)
    expect(buffer.entries.map((e) => e.at)).toEqual([500, 1500]);
  });

  it("evicts by count once past maxEntries, oldest first", () => {
    let buffer = emptyBuffer();
    const limits = { maxEntries: 3, maxAgeMs: 1_000_000 };
    buffer = append(buffer, push(0), limits);
    buffer = append(buffer, push(1), limits);
    buffer = append(buffer, push(2), limits);
    buffer = append(buffer, push(3), limits);
    expect(buffer.entries.map((e) => e.at)).toEqual([1, 2, 3]);
  });

  it("uses BUFFER_LIMITS as the default cap", () => {
    expect(BUFFER_LIMITS).toEqual({ maxEntries: 600, maxAgeMs: 180_000 });
    let buffer = emptyBuffer();
    for (let i = 0; i <= BUFFER_LIMITS.maxEntries; i++) {
      buffer = append(buffer, push(i));
    }
    expect(buffer.entries.length).toBe(BUFFER_LIMITS.maxEntries);
    expect(buffer.entries[0]?.at).toBe(1);
  });
});

describe("select", () => {
  it("returns null for an empty buffer", () => {
    expect(select(emptyBuffer(), 100)).toBeNull();
  });

  it("returns null when every entry is newer than the target", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(100));
    expect(select(buffer, 50)).toBeNull();
  });

  it("returns the exact match when at equals target", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(100));
    buffer = append(buffer, push(200));
    expect(select(buffer, 200)).toEqual(push(200));
  });

  it("returns the newest entry with at <= target", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(100));
    buffer = append(buffer, push(200));
    buffer = append(buffer, push(300));
    expect(select(buffer, 250)).toEqual(push(200));
  });

  it("returns the newest entry when target is past the newest", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(100));
    buffer = append(buffer, push(200));
    expect(select(buffer, 10_000)).toEqual(push(200));
  });
});

describe("span", () => {
  it("is 0 for an empty buffer", () => {
    expect(span(emptyBuffer())).toBe(0);
  });

  it("is 0 for a single entry", () => {
    expect(span(append(emptyBuffer(), push(100)))).toBe(0);
  });

  it("is newest.at - oldest.at for two or more entries", () => {
    let buffer = emptyBuffer();
    buffer = append(buffer, push(100));
    buffer = append(buffer, push(700));
    expect(span(buffer)).toBe(600);
  });
});
