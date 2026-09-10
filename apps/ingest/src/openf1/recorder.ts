// Adapted from `../f1-live-events-poc/poc/live-recorder/recorder.ts`'s file
// writes. "The jsonl recording is still written — it is the irreplaceable
// artefact, not a stopgap." (apps/ingest/AGENTS.md). Writes under
// `LIVE_LOG_DIR` (default `./live-logs`, gitignored), one directory per
// session, matching the file fetcher's
// `<dir>/<session_key>/{session.json, raw/<endpoint>.jsonl}` layout so a
// recording made here can later replay through the same rest lane.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RawRecord } from "./types.js";

// The caller (rest-lane.ts) validates session_key before this ever runs,
// but the recorder builds filesystem paths from it — it must not trust that
// unconditionally. Only a finite non-negative integer is a real OpenF1
// session_key; anything else (a string like "../x", a non-integer number)
// is rejected before any mkdir/path join, not sanitized into something
// "safe".
function validSessionKey(sessionKey: string | number): number {
  const n = typeof sessionKey === "number" ? sessionKey : Number(sessionKey);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`JsonlRecorder: invalid session_key: ${JSON.stringify(sessionKey)}`);
  }
  return n;
}

export class JsonlRecorder {
  public constructor(private readonly rootDir: string) {}

  public async writeSession(session: RawRecord, sessionKey: string | number): Promise<void> {
    const key = validSessionKey(sessionKey);
    const dir = path.join(this.rootDir, String(key));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ session, discovered_at: new Date().toISOString() }, null, 2) + "\n",
    );
  }

  /** Appends only NEW rows (the caller already deduped via the normalizer). */
  public async appendRows(sessionKey: string | number, endpoint: string, rows: RawRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const key = validSessionKey(sessionKey);
    const dir = path.join(this.rootDir, String(key), "raw");
    await mkdir(dir, { recursive: true });
    const receivedAt = new Date().toISOString();
    const lines = rows.map((payload) => JSON.stringify({ received_at: receivedAt, payload }));
    await appendFile(path.join(dir, `${endpoint}.jsonl`), lines.join("\n") + "\n");
  }
}
