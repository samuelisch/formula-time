import { describe, expect, it } from "vitest";

import { countFields, createLogger } from "./log.js";

/** In-memory pino destination: collects each written line for assertions. */
function collector(): { lines: string[]; stream: { write(chunk: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (chunk) => void lines.push(chunk) } };
}

describe("countFields", () => {
  it("extracts the mqtt lane's stats line counts", () => {
    // apps/ingest/src/openf1/mqtt-lane.ts's periodic stats message.
    expect(countFields("mqtt: last 60s messages=12 rows=34 dropped=0")).toEqual({
      messages: 12,
      rows: 34,
      dropped: 0,
    });
  });

  it("extracts the rest lane's entry-list fetch counts", () => {
    // apps/ingest/src/openf1/rest-lane.ts's entry-list fetch message.
    expect(
      countFields(
        "entry list: fetched session_key=9999 rows=20 new=20 foreign=0 unknown_session=0",
      ),
    ).toEqual({ rows: 20, new: 20, foreign: 0, unknown_session: 0 });
  });

  it("extracts the rest lane's poll counts, ignoring names outside the list", () => {
    // apps/ingest/src/openf1/rest-lane.ts's per-endpoint poll message; `malformed`
    // isn't a listed count field.
    expect(countFields("rest: poll endpoint=laps rows=5 new=5 malformed=0")).toEqual({
      rows: 5,
      new: 5,
    });
  });

  it("extracts the writer's batch counts", () => {
    // apps/ingest/src/writer/writer.ts's batch-result message.
    expect(countFields("writer: batch inserted=42 skipped=3")).toEqual({ inserted: 42, skipped: 3 });
  });

  it("returns an empty object when the message carries no counts", () => {
    expect(countFields("ingest: SIGTERM received, draining queue")).toEqual({});
  });
});

describe("createLogger", () => {
  it("writes one JSON line with service, lane, msg and the count fields", () => {
    const { lines, stream } = collector();
    const logger = createLogger({ destination: stream });
    const message = "writer: batch inserted=5 skipped=1";

    logger.info({ lane: "writer", ...countFields(message) }, message);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["service"]).toBe("ingest");
    expect(parsed["lane"]).toBe("writer");
    expect(parsed["msg"]).toBe(message);
    expect(parsed["inserted"]).toBe(5);
    expect(parsed["skipped"]).toBe(1);
  });

  it("a caller's fields must not repeat a base binding field (build), or the line carries the key twice", () => {
    const { lines, stream } = collector();
    const logger = createLogger({ destination: stream });

    // apps/ingest/src/main.ts's startup "ingest: config" line: `build`
    // comes only from the base binding, never as one of the call's own
    // fields, since pino appends fields alongside base bindings rather
    // than merging them — a repeated key would write the key twice.
    logger.info(
      { live_source: "api", mqtt_enabled: false, rest_tick_ms: 2200, sponsored: false },
      "ingest: config",
    );

    expect(lines).toHaveLength(1);
    expect((lines[0]?.match(/"build":/g) ?? []).length).toBe(1);
  });

  it("LOG_LEVEL=warn silences info", () => {
    const original = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "warn";
    try {
      const { lines, stream } = collector();
      const logger = createLogger({ destination: stream });

      logger.info({ lane: "rest" }, "rest: session discovery failed");

      expect(lines).toHaveLength(0);
    } finally {
      if (original === undefined) delete process.env["LOG_LEVEL"];
      else process.env["LOG_LEVEL"] = original;
    }
  });
});
