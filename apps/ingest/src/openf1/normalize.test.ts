import { describe, expect, test } from "vitest";

import { LiveNormalizer, eventId, timestampMillis, timestampValue } from "./normalize.js";

describe("eventId", () => {
  test("a REST row and its MQTT-shaped twin (with `_id`/`_key` envelope) hash to the same event id", () => {
    const restRow = { session_key: 11361, driver_number: 1, date: "2026-09-06T13:00:00+00:00" };
    const mqttRow = {
      session_key: 11361,
      driver_number: 1,
      date: "2026-09-06T13:00:00",
      _id: 42,
      _key: "abc123",
    };

    expect(eventId("position", restRow)).toBe(eventId("position", mqttRow));
  });

  test("differs by endpoint even for the same payload", () => {
    const row = { driver_number: 1 };
    expect(eventId("position", row)).not.toBe(eventId("intervals", row));
  });

  test("an offset-less timestamp canonicalizes to UTC, same as an explicit +00:00 offset", () => {
    const a = eventId("position", { date: "2026-09-06T13:00:00" });
    const b = eventId("position", { date: "2026-09-06T13:00:00+00:00" });
    const c = eventId("position", { date: "2026-09-06T13:00:00Z" });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("key order does not change the id (stableJson sorts keys)", () => {
    const a = eventId("position", { a: 1, b: 2 });
    const b = eventId("position", { b: 2, a: 1 });
    expect(a).toBe(b);
  });
});

describe("timestampValue / timestampMillis", () => {
  test("timestampValue accepts a parseable ISO string, rejects everything else", () => {
    expect(timestampValue("2026-09-06T13:00:00Z")).toBe("2026-09-06T13:00:00Z");
    expect(timestampValue("not a date")).toBeNull();
    expect(timestampValue(42)).toBeNull();
    expect(timestampValue(null)).toBeNull();
  });

  test("timestampMillis parses, or passes null through", () => {
    expect(timestampMillis("2026-09-06T13:00:00Z")).toBe(Date.parse("2026-09-06T13:00:00Z"));
    expect(timestampMillis(null)).toBeNull();
  });
});

describe("LiveNormalizer", () => {
  test("dedups repeated rows across polls for the same endpoint", () => {
    const normalizer = new LiveNormalizer();
    const row = { driver_number: 1, date: "2026-09-06T13:00:00Z" };

    const first = normalizer.normalize("position", [row]);
    const second = normalizer.normalize("position", [row]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("carries sourceTime from the endpoint's configured timestamp field", () => {
    const normalizer = new LiveNormalizer();
    const [event] = normalizer.normalize("laps", [
      { driver_number: 1, lap_number: 1, date_start: "2026-09-06T13:00:00Z" },
    ]);
    expect(event?.sourceTime).toBe("2026-09-06T13:00:00Z");
  });

  test("stints infers sourceTime from the matching lap's date_start, seen earlier on the `laps` endpoint", () => {
    const normalizer = new LiveNormalizer();
    normalizer.normalize("laps", [
      { driver_number: 44, lap_number: 3, date_start: "2026-09-06T13:10:00Z" },
    ]);
    const [stint] = normalizer.normalize("stints", [{ driver_number: 44, lap_start: 3 }]);
    expect(stint?.sourceTime).toBe("2026-09-06T13:10:00Z");
  });

  test("stints with no matching lap seen yet gets a null sourceTime, not a throw", () => {
    const normalizer = new LiveNormalizer();
    const [stint] = normalizer.normalize("stints", [{ driver_number: 99, lap_start: 1 }]);
    expect(stint?.sourceTime).toBeNull();
  });

  test("an endpoint with no configured timestamp field gets a null sourceTime", () => {
    const normalizer = new LiveNormalizer();
    const [event] = normalizer.normalize("drivers", [{ driver_number: 1 }]);
    expect(event?.sourceTime).toBeNull();
  });
});
