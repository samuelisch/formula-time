// Startup probe for the jsonl recording root. RAILWAY_RUN_UID=0
// (.railway/railway.ts, ADR-0036) is what lets the ingest process write
// under a Railway volume Railway mounts root:root; this probe is what
// reports when that write will not land, at boot, instead of thirty
// minutes into a race (ADR-0034: a disk problem must never stop a lane).
// fs operations are injected so unit tests use fakes only, never a real
// tmpdir (apps/ingest/AGENTS.md: unit tests are in-memory fakes only).

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
}

const WRITE_PROBE_NAME = ".write-probe";

/**
 * Checks that `dir` is writable, creating it if needed, and — only when an
 * operator explicitly named an absolute directory — that it actually sits
 * on a mounted volume rather than the container's own ephemeral disk. An
 * operator who sets an absolute LIVE_LOG_DIR is naming a specific location;
 * if that location shares a device with `/` it is the root filesystem,
 * which Railway discards on every deploy.
 */
export async function checkRecordingRoot({
  dir,
  liveLogDirExplicit,
  fs,
}: RecordingRootCheck): Promise<RecordingRootResult> {
  if (liveLogDirExplicit && path.isAbsolute(dir)) {
    const [dirDevice, rootDevice] = await Promise.all([fs.deviceOf(dir), fs.deviceOf("/")]);
    if (dirDevice === rootDevice) {
      return { ok: false, reason: "not-a-mount" };
    }
  }

  // A real write, not a bare mkdir: mkdir on an existing root-owned
  // directory is a no-op that succeeds while every later append still
  // fails EACCES.
  let createdPath: string | undefined;
  try {
    createdPath = await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, WRITE_PROBE_NAME), "");
  } catch (error) {
    return {
      ok: false,
      reason: "not-writable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await fs.rm(path.join(dir, WRITE_PROBE_NAME));
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
