import { describe, expect, test, vi } from "vitest";

import { checkRecordingRoot } from "./recording-root.js";
import type { RecordingRootFs } from "./recording-root.js";

// Default deviceOf distinguishes "/" from everything else, so a test that
// doesn't care about the not-a-mount check gets a directory that isn't on
// root's device; a test that does care overrides this explicitly.
function fakeFs(overrides: Partial<RecordingRootFs> = {}): RecordingRootFs {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    deviceOf: vi.fn(async (target: string) => (target === "/" ? 1 : 2)),
    ...overrides,
  };
}

describe("checkRecordingRoot", () => {
  test("a missing directory is created", async () => {
    const fs = fakeFs({ mkdir: vi.fn().mockResolvedValue("/data/live-logs") });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: true, fs });
    expect(result).toEqual({ ok: true, created: true });
  });

  test("an existing writable directory is not reported as created", async () => {
    const fs = fakeFs({ mkdir: vi.fn().mockResolvedValue(undefined) });
    const result = await checkRecordingRoot({ dir: "./live-logs", liveLogDirExplicit: false, fs });
    expect(result).toEqual({ ok: true, created: false });
  });

  test("mkdir rejecting EACCES is not-writable, carrying the error's message", async () => {
    const fs = fakeFs({ mkdir: vi.fn().mockRejectedValue(new Error("EACCES: permission denied, mkdir '/data/live-logs'")) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: true, fs });
    expect(result).toEqual({
      ok: false,
      reason: "not-writable",
      message: "EACCES: permission denied, mkdir '/data/live-logs'",
    });
  });

  test("mkdir succeeding but the write probe rejecting is still not-writable (a mkdir-only check would wrongly pass)", async () => {
    const fs = fakeFs({
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockRejectedValue(new Error("EACCES: permission denied, open '/data/live-logs/.write-probe'")),
    });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: true, fs });
    expect(result).toEqual({
      ok: false,
      reason: "not-writable",
      message: "EACCES: permission denied, open '/data/live-logs/.write-probe'",
    });
  });

  test("an explicit absolute dir on the same device as / is not-a-mount, and no write is attempted", async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const fs = fakeFs({ mkdir, writeFile, deviceOf: vi.fn().mockResolvedValue(42) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: true, fs });
    expect(result).toEqual({ ok: false, reason: "not-a-mount" });
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  test("the default relative dir, unset explicitly, is never reported as not-a-mount even on /'s device", async () => {
    const fs = fakeFs({ deviceOf: vi.fn().mockResolvedValue(7) });
    const result = await checkRecordingRoot({ dir: "./live-logs", liveLogDirExplicit: false, fs });
    expect(result).toEqual({ ok: true, created: false });
    expect(fs.deviceOf).not.toHaveBeenCalled();
  });

  test("an explicit but relative dir never triggers the not-a-mount check", async () => {
    const fs = fakeFs({ deviceOf: vi.fn().mockResolvedValue(7) });
    const result = await checkRecordingRoot({ dir: "./live-logs", liveLogDirExplicit: true, fs });
    expect(result).toEqual({ ok: true, created: false });
    expect(fs.deviceOf).not.toHaveBeenCalled();
  });

  test("removal of the write probe is best-effort: its failure does not turn a writable result into not-writable", async () => {
    const fs = fakeFs({ rm: vi.fn().mockRejectedValue(new Error("ENOENT")) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: false, fs });
    expect(result).toEqual({ ok: true, created: false });
  });

  test("a mkdir that never resolves (a wedged mount) times out instead of hanging the probe forever", async () => {
    const fs = fakeFs({ mkdir: vi.fn(() => new Promise<string | undefined>(() => {})) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: false, fs, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-writable");
      expect(result.reason === "not-writable" && result.message).toMatch(/timed out/i);
    }
  });

  test("a write probe that never resolves times out instead of hanging the probe forever", async () => {
    const fs = fakeFs({ writeFile: vi.fn(() => new Promise<void>(() => {})) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: false, fs, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-writable");
    }
  });

  test("the not-a-mount device check timing out is reported as not-writable rather than hanging forever", async () => {
    const fs = fakeFs({ deviceOf: vi.fn(() => new Promise<number>(() => {})) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: true, fs, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-writable");
    }
  });

  test("a write-probe removal that never resolves still lets a writable result return", async () => {
    const fs = fakeFs({ rm: vi.fn(() => new Promise<void>(() => {})) });
    const result = await checkRecordingRoot({ dir: "/data/live-logs", liveLogDirExplicit: false, fs, timeoutMs: 20 });
    expect(result).toEqual({ ok: true, created: false });
  });
});
