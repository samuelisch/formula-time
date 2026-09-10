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

    expect(first.rows).toHaveLength(1);
    expect(first.malformed).toBe(0);
    expect(second.rows).toHaveLength(0);
    expect(second.malformed).toBe(0);
  });

  test("carries sourceTime from the endpoint's configured timestamp field", () => {
    const normalizer = new LiveNormalizer();
    const { rows: [event] } = normalizer.normalize("laps", [
      { driver_number: 1, lap_number: 1, date_start: "2026-09-06T13:00:00Z" },
    ]);
    expect(event?.sourceTime).toBe("2026-09-06T13:00:00Z");
  });

  test("stints infers sourceTime from the matching lap's date_start, seen earlier on the `laps` endpoint", () => {
    const normalizer = new LiveNormalizer();
    normalizer.normalize("laps", [
      { driver_number: 44, lap_number: 3, date_start: "2026-09-06T13:10:00Z" },
    ]);
    const { rows: [stint] } = normalizer.normalize("stints", [{ driver_number: 44, lap_start: 3 }]);
    expect(stint?.sourceTime).toBe("2026-09-06T13:10:00Z");
  });

  test("stints with no matching lap seen yet gets a null sourceTime, not a throw", () => {
    const normalizer = new LiveNormalizer();
    const { rows: [stint] } = normalizer.normalize("stints", [{ driver_number: 99, lap_start: 1 }]);
    expect(stint?.sourceTime).toBeNull();
  });

  test("an endpoint with no configured timestamp field gets a null sourceTime", () => {
    const normalizer = new LiveNormalizer();
    const { rows: [event] } = normalizer.normalize("drivers", [{ driver_number: 1 }]);
    expect(event?.sourceTime).toBeNull();
  });

  // `overtakes` is one of the eight named MQTT topics (REST's
  // POLL_ROTATION never polls it). It must be present in
  // endpointConfigs — otherwise every overtakes row gets a null sourceTime.
  // Payload shape confirmed against a real capture: `../f1-live-events-poc/poc/
  // live-logs/mqtt-probe-2026-09-06T12-57-39-863Z/topics/v1_overtakes.jsonl`
  // — `{"meeting_key":1293,"session_key":11361,"overtaking_driver_number":81,
  // "overtaken_driver_number":3,"date":"2026-09-06T13:03:40.488000",
  // "position":5,"_key":"...","_id":...}` — a `date` field, same shape as
  // position/intervals/pit/race_control/weather.
  test("overtakes carries sourceTime from its `date` field (real capture: mqtt-probe .../topics/v1_overtakes.jsonl)", () => {
    const normalizer = new LiveNormalizer();
    const { rows: [event] } = normalizer.normalize("overtakes", [
      {
        meeting_key: 1293,
        session_key: 11361,
        overtaking_driver_number: 81,
        overtaken_driver_number: 3,
        date: "2026-09-06T13:03:40.488000",
        position: 5,
      },
    ]);
    expect(event?.sourceTime).toBe("2026-09-06T13:03:40.488000");
  });

  test("a malformed row (null) is skipped and counted, without throwing or losing later rows", () => {
    const normalizer = new LiveNormalizer();
    const valid1 = { driver_number: 1, date: "2026-09-06T13:00:00Z" };
    const valid2 = { driver_number: 2, date: "2026-09-06T13:00:01Z" };
    const rows = [valid1, null, valid2] as unknown as Array<Record<string, unknown>>;

    const first = normalizer.normalize("position", rows);

    expect(first.rows).toHaveLength(2);
    expect(first.malformed).toBe(1);
    expect(first.rows.map((r) => r.payload)).toEqual([valid1, valid2]);

    // The valid rows' ids are marked seen; the null's is not (there is no id
    // for it to mark — it throws before eventId() ever returns one).
    const second = normalizer.normalize("position", rows);
    expect(second.rows).toHaveLength(0); // both valid rows already seen
    expect(second.malformed).toBe(1); // the null still throws, every time
  });
});
