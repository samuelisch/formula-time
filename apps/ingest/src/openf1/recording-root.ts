// Startup probe for the jsonl recording root. RAILWAY_RUN_UID=0
// (.railway/railway.ts, ADR-0036) lets ingest write under a Railway
// volume Railway mounts root:root; this probe reports when that write
// will not land, at boot, instead of thirty minutes into a race
// (ADR-0034: a disk problem must never stop a lane).

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type RecordingRootResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "not-writable"; message: string }
  | { ok: false; reason: "not-a-mount" };

export interface RecordingRootFs {
  /** Mirrors `fs.promises.mkdir(dir, { recursive: true })`: resolves to the
   * first directory path actually created, or `undefined` when the whole
   * path already existed. */
  mkdir: (dir: string, opts: { recursive: true }) => Promise<string | undefined>;
  writeFile: (filePath: string, data: string) => Promise<void>;
  rm: (filePath: string) => Promise<void>;
  /** The device id of `target`, or its nearest existing ancestor when
   * `target` itself does not exist yet. */
  deviceOf: (target: string) => Promise<number>;
}

export interface RecordingRootCheck {
  dir: string;
  /** True only when LIVE_LOG_DIR was set explicitly in the environment
   * (config.ts's `liveLogDirExplicit`) — the default relative `./live-logs`
   * must never trigger the not-a-mount check. */
  liveLogDirExplicit: boolean;
  fs: RecordingRootFs;
  /** Bounds every injected fs call (default 5000ms). A wedged mount hangs a
   * bare `await` forever; nothing restarts `ingest` (only `api` declares a
   * healthcheck), so a probe with no bound would turn a disk problem into
   * "the lanes never start" instead of the "not writable" it means to
   * report. */
  timeoutMs?: number;
}

const WRITE_PROBE_NAME = ".write-probe";
const DEFAULT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Checks that `dir` is writable, creating it if needed, and — only when
 * an operator named an absolute directory — that it sits on a mounted
 * volume rather than the container's own ephemeral disk, which Railway
 * discards on every deploy.
 */
export async function checkRecordingRoot({
  dir,
  liveLogDirExplicit,
  fs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RecordingRootCheck): Promise<RecordingRootResult> {
  if (liveLogDirExplicit && path.isAbsolute(dir)) {
    try {
      const [dirDevice, rootDevice] = await Promise.all([
        withTimeout(fs.deviceOf(dir), timeoutMs, `deviceOf(${dir})`),
        withTimeout(fs.deviceOf("/"), timeoutMs, "deviceOf(/)"),
      ]);
      if (dirDevice === rootDevice) {
        return { ok: false, reason: "not-a-mount" };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "not-writable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // A real write, not a bare mkdir: mkdir on an existing root-owned
  // directory is a no-op that succeeds while every later append still
  // fails EACCES.
  let createdPath: string | undefined;
  try {
    createdPath = await withTimeout(fs.mkdir(dir, { recursive: true }), timeoutMs, `mkdir(${dir})`);
    await withTimeout(fs.writeFile(path.join(dir, WRITE_PROBE_NAME), ""), timeoutMs, "writeFile(write-probe)");
  } catch (error) {
    return {
      ok: false,
      reason: "not-writable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await withTimeout(fs.rm(path.join(dir, WRITE_PROBE_NAME)), timeoutMs, "rm(write-probe)");
  } catch {
    // Best-effort cleanup; a failed removal doesn't mean the directory
    // isn't writable.
  }

  return { ok: true, created: createdPath !== undefined };
}

async function statDevice(target: string): Promise<number> {
  let current = target;
  for (;;) {
    try {
      const info = await stat(current);
      return info.dev;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** The real filesystem, for main.ts. Unit tests use fakes instead. */
export const realRecordingRootFs: RecordingRootFs = {
  mkdir: (dir, opts) => mkdir(dir, opts),
  writeFile: (filePath, data) => writeFile(filePath, data),
  rm: (filePath) => rm(filePath),
  deviceOf: statDevice,
};
