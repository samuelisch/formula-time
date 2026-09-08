// Adapted from `../f1-live-events-poc/poc/live-recorder/recorder.ts`'s file
// writes. "The jsonl recording is still written — it is the irreplaceable
// artefact, not a stopgap." (apps/ingest/AGENTS.md). Writes under
// `LIVE_LOG_DIR` (default `./live-logs`, gitignored — issue deliverable
// "Config"), one directory per session, matching the file fetcher's
// `<dir>/<session_key>/{session.json, raw/<endpoint>.jsonl}` layout so a
// recording made here can later replay through the same rest lane.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RawRecord } from "./types.js";

export class JsonlRecorder {
  public constructor(private readonly rootDir: string) {}

  public async writeSession(session: RawRecord, sessionKey: string | number): Promise<void> {
    const dir = path.join(this.rootDir, String(sessionKey));
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({ session, discovered_at: new Date().toISOString() }, null, 2) + "\n",
    );
  }

  /** Appends only NEW rows (the caller already deduped via the normalizer). */
  public async appendRows(sessionKey: string | number, endpoint: string, rows: RawRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const dir = path.join(this.rootDir, String(sessionKey), "raw");
    await mkdir(dir, { recursive: true });
    const receivedAt = new Date().toISOString();
    const lines = rows.map((payload) => JSON.stringify({ received_at: receivedAt, payload }));
    await appendFile(path.join(dir, `${endpoint}.jsonl`), lines.join("\n") + "\n");
  }
}
