// Lifted from `../f1-live-events-poc/poc/ts/file_fetcher.ts`. A `Fetcher`
// (ADR-0001 §4: "the Postgres fetcher answers the same virtual URLs the file
// fetcher does") that serves the rest lane from a live-recorder capture
// instead of the network — this is what `LIVE_SOURCE=<directory>` selects
// (config seam), used by tests and manual replay.
//
// Accepts either layout — no session key needs to be known up front:
//   root mode:    <dir>/<session_key>/{session.json, raw/<endpoint>.jsonl}
//   single mode:  <dir>/{session.json, raw/<endpoint>.jsonl}

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Fetcher, RawRecord } from "./types.js";

interface JsonlRow {
  receivedAt: string | null;
  payload: RawRecord;
}

async function readJsonlRows(filePath: string): Promise<JsonlRow[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return []; // recorder hasn't written this endpoint yet
  }
  const rows: JsonlRow[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { received_at?: unknown; payload?: RawRecord };
      if (parsed.payload) {
        rows.push({
          receivedAt: typeof parsed.received_at === "string" ? parsed.received_at : null,
          payload: parsed.payload,
        });
      }
    } catch {
      // ignore a partially-written trailing line; it will be complete next poll
    }
  }
  return rows;
}

async function readJsonl(filePath: string): Promise<RawRecord[]> {
  return (await readJsonlRows(filePath)).map((row) => row.payload);
}

async function readSessionJson(filePath: string): Promise<RawRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { session?: RawRecord };
    return parsed.session ?? null;
  } catch {
    return null;
  }
}

export function createFileFetcher(dir: string): Fetcher {
  return async (url: string): Promise<unknown> => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.split("/").at(-1) ?? "";

    if (endpoint === "sessions") {
      const single = await readSessionJson(path.join(dir, "session.json"));
      if (single) return [single];
      const sessions: RawRecord[] = [];
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const session = await readSessionJson(path.join(dir, entry.name, "session.json"));
          if (session) sessions.push(session);
        }
      } catch {
        // root doesn't exist yet — recorder hasn't started
      }
      return sessions;
    }

    const sessionKey = parsed.searchParams.get("session_key");
    const candidates = [
      ...(sessionKey ? [path.join(dir, sessionKey, "raw", `${endpoint}.jsonl`)] : []),
      path.join(dir, "raw", `${endpoint}.jsonl`),
    ];
    for (const candidate of candidates) {
      const rows = await readJsonl(candidate);
      if (rows.length > 0) return rows;
    }
    return [];
  };
}

/** One recorded row, with the `received_at` the `Fetcher` seam above drops. */
export interface RecordedRow {
  receivedAt: string | null;
  endpoint: string;
  payload: RawRecord;
}

/**
 * The loader needs `received_at` (dropped by `readJsonl` above,
 * kept out of the `Fetcher` contract on purpose — ADR-0001 §4's fetcher
 * seam answers the same virtual URLs the network fetcher does, payloads
 * only) to sort a whole recording into time order before emitting. Sibling
 * reader, not a change to `createFileFetcher`'s behaviour: same
 * root-vs-single-session candidate-path resolution, one endpoint at a time.
 */
export async function readRecordingEndpoint(
  dir: string,
  sessionKey: number | null,
  endpoint: string,
): Promise<RecordedRow[]> {
  const candidates = [
    ...(sessionKey !== null ? [path.join(dir, String(sessionKey), "raw", `${endpoint}.jsonl`)] : []),
    path.join(dir, "raw", `${endpoint}.jsonl`),
  ];
  for (const candidate of candidates) {
    const rows = await readJsonlRows(candidate);
    if (rows.length > 0) {
      return rows.map((row) => ({ receivedAt: row.receivedAt, endpoint, payload: row.payload }));
    }
  }
  return [];
}
