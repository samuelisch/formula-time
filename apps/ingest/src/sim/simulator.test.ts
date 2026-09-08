// Ported from `../f1-live-events-poc/poc/live-recorder/simulator_test.ts`
// (issue #56: "port the POC's cases to vitest").

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import type { RawRecord } from "../openf1/types.js";
import { loadRecordingRows, runSimulation, scheduleAt, shiftSessionWindow, startCutMs } from "./simulator.js";

describe("shiftSessionWindow", () => {
  test("moves the window, leaves everything else alone", () => {
    const session: RawRecord = {
      session_key: 11353,
      country_name: "Netherlands",
      date_start: "2026-08-23T13:00:00+00:00",
      date_end: "2026-08-23T15:00:00+00:00",
    };
    const shifted = shiftSessionWindow(session, 60 * 60 * 1000);
    expect(shifted.date_start).toBe("2026-08-23T14:00:00.000Z");
    expect(shifted.date_end).toBe("2026-08-23T16:00:00.000Z");
    expect(shifted.country_name).toBe("Netherlands");
  });
});

describe("scheduleAt", () => {
  test("absolute deadlines, scaled by speed", () => {
    const row = { receivedAt: 10_000, endpoint: "position", line: "{}" };
    expect(scheduleAt(row, 0, 1000, 1)).toBe(11_000);
    expect(scheduleAt(row, 0, 1000, 10)).toBe(2_000);
  });
});

describe("startCutMs", () => {
  const rows = [
    { receivedAt: 0, endpoint: "drivers", line: "{}" },
    { receivedAt: 100_000, endpoint: "position", line: "{}" },
    { receivedAt: 200_000, endpoint: "laps", line: "{}" },
    { receivedAt: 300_000, endpoint: "laps", line: "{}" },
  ];

  test("default: drip from the first row", () => {
    expect(startCutMs(rows, "recording")).toBe(0);
  });

  test("race: first laps row minus the 60s lead", () => {
    expect(startCutMs(rows, "race")).toBe(140_000);
  });

  test("lead reaching past the start clamps to the start", () => {
    expect(startCutMs(rows, "race", 250_000)).toBe(0);
  });

  test("no laps rows -> fall back to the recording start", () => {
    expect(startCutMs([{ receivedAt: 5, endpoint: "position", line: "{}" }], "race")).toBe(5);
  });
});

describe("loadRecordingRows", () => {
  const fixture = path.join(tmpdir(), `sim-test-recording-${process.pid}`);

  test("merges endpoints, sorts by received_at", async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(path.join(fixture, "raw"), { recursive: true });
    await writeFile(
      path.join(fixture, "session.json"),
      JSON.stringify({
        session: {
          session_key: 11353,
          country_name: "Testland",
          date_start: "2026-08-23T13:00:00+00:00",
          date_end: "2026-08-23T15:00:00+00:00",
        },
      }) + "\n",
    );
    await writeFile(
      path.join(fixture, "raw", "position.jsonl"),
      [
        JSON.stringify({ received_at: "2026-08-23T13:00:02.000Z", payload: { driver_number: 1, position: 1, date: "2026-08-23T12:59:59Z" } }),
        JSON.stringify({ received_at: "2026-08-23T13:00:04.000Z", payload: { driver_number: 1, position: 2, date: "2026-08-23T13:00:01Z" } }),
      ].join("\n") + "\n",
    );
    await writeFile(
      path.join(fixture, "raw", "drivers.jsonl"),
      JSON.stringify({ received_at: "2026-08-23T13:00:00.000Z", payload: { driver_number: 1, full_name: "Sim Driver" } }) + "\n",
    );

    const rows = await loadRecordingRows(fixture);
    expect(rows.length).toBe(3);
    expect(rows.map((row) => row.endpoint)).toEqual(["drivers", "position", "position"]);

    await rm(fixture, { recursive: true, force: true });
  });
});

describe("runSimulation", () => {
  const fixture = path.join(tmpdir(), `sim-test-run-${process.pid}`);
  const outRoot = path.join(tmpdir(), `sim-test-out-${process.pid}`);

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
    await rm(outRoot, { recursive: true, force: true });
  });

  test("drips a tiny recording end to end, shifting the session window and re-keying session_key", async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(path.join(fixture, "raw"), { recursive: true });
    await writeFile(
      path.join(fixture, "session.json"),
      JSON.stringify({
        session: {
          session_key: 11353,
          country_name: "Netherlands",
          date_start: "2026-08-23T13:00:00+00:00",
          date_end: "2026-08-23T15:00:00+00:00",
        },
      }) + "\n",
    );
    await writeFile(
      path.join(fixture, "raw", "position.jsonl"),
      [
        JSON.stringify({ received_at: "2026-08-23T13:00:00.000Z", payload: { driver_number: 1, position: 1 } }),
        JSON.stringify({ received_at: "2026-08-23T13:00:00.400Z", payload: { driver_number: 1, position: 2 } }),
      ].join("\n") + "\n",
    );
    await writeFile(
      path.join(fixture, "raw", "drivers.jsonl"),
      JSON.stringify({ received_at: "2026-08-23T13:00:00.000Z", payload: { driver_number: 1, full_name: "Sim Driver" } }) + "\n",
    );

    await rm(outRoot, { recursive: true, force: true });
    await runSimulation({ recordingDir: fixture, simKey: 70707, outRoot, speed: 20, start: "recording", onLog: () => {} });

    const outDir = path.join(outRoot, "70707");
    const written = JSON.parse(await readFile(path.join(outDir, "session.json"), "utf8")) as {
      session: RawRecord;
      speed: number;
    };
    expect(written.session.session_key).toBe(70707);
    expect(written.session.simulated).toBe(true);
    expect(written.speed).toBe(20);
    const windowStart = Date.parse(String(written.session.date_start));
    expect(Math.abs(windowStart - Date.now())).toBeLessThan(60_000);

    const position = (await readFile(path.join(outDir, "raw", "position.jsonl"), "utf8")).trim().split("\n");
    expect(position.length).toBe(2);
    const drivers = (await readFile(path.join(outDir, "raw", "drivers.jsonl"), "utf8")).trim().split("\n");
    expect(drivers.length).toBe(1);
  });

  test("refuses to overwrite a directory that looks like a real recording (has polls.jsonl)", async () => {
    const realOutRoot = path.join(tmpdir(), `sim-test-real-${process.pid}`);
    const realOutDir = path.join(realOutRoot, "70708");
    await rm(realOutRoot, { recursive: true, force: true });
    await mkdir(realOutDir, { recursive: true });
    await writeFile(path.join(realOutDir, "polls.jsonl"), "");

    await expect(
      runSimulation({ recordingDir: fixture, simKey: 70708, outRoot: realOutRoot, speed: 20, start: "recording", onLog: () => {} }),
    ).rejects.toThrow(/looks like a real recording/);

    await rm(realOutRoot, { recursive: true, force: true });
  });
});
