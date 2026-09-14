// dump-recording — the loader's inverse: reads one session back out of
// `sessions` + `events` and writes it in the recording layout the loader
// (`load-recording.ts`) and the drip simulator (`sim/simulator.ts`) both
// read: `session.json`, `raw/<endpoint>.jsonl` (one line per event, the
// recorder's own `{ received_at, payload }` shape), and an empty
// `polls.jsonl` so the simulator's real-recording guard ("never wipe a real
// recording") treats this directory as real. Round trip is the invariant:
// `load-recording --replace` of this output reproduces the same `event_id`
// set in the same `received_at` order as the source, because it is fed the
// same payloads, in the same per-endpoint order, that produced them.
//
// Runs against the deployed database over `railway ssh` (no public proxy),
// same as the loader and `fetch-race` — see the load-race skill's
// "Dump a recording" section for the tarball-out procedure.
//
// Usage: `DATABASE_URL=... pnpm ingest:dump -- <session_key> [--out <dir>]
// [--force]` (package.json script "dump"; root script "ingest:dump").

import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@formula-time/db";

import { loadConfig } from "./config.js";
import type { RawRecord } from "./openf1/types.js";

// Same page size as the api's exporter (`readAllEvents`, ADR-0009 §2): pages
// by `seq` so a whole race is never held in memory at once.
const PAGE_SIZE = 5000;

/** The `sessions` columns this command reads — a slice, not the generated `Session` model, so a test fake needs no Prisma types. */
export interface DumpSessionRow {
  sessionKey: bigint;
  name: string;
  country: string;
  circuitKey: number;
  circuitShortName: string | null;
  location: string | null;
  dateStart: Date;
  dateEnd: Date;
}

/** One `events` row as this command reads it — no `eventId` column: the dumped line carries only what the recorder itself ever wrote, and the loader recomputes identity from the payload. */
export interface DumpEventRow {
  seq: bigint;
  endpoint: string;
  receivedAt: Date;
  payload: unknown;
}

/** The slice of the Prisma client this command needs — real client or a fake (unit test). */
export interface DumpDb {
  session: {
    findUnique(args: { where: { sessionKey: bigint } }): Promise<DumpSessionRow | null>;
  };
  event: {
    findMany(args: {
      where: { sessionKey: bigint; seq: { gt: bigint } };
      orderBy: { seq: "asc" };
      take: number;
      select: { seq: true; endpoint: true; receivedAt: true; payload: true };
    }): Promise<DumpEventRow[]>;
  };
}

/**
 * The stored `sessions` row translated back to OpenF1's own field names —
 * the shape `sessionFieldsFromRaw` and `isRaceSession` (writer/sessions.ts)
 * read out of a recording's `session.json`. The table does not keep every
 * field a live OpenF1 `sessions` row carries: no `session_type`, `year`,
 * `gmt_offset`, `country_key`, `country_code`, `is_cancelled`, or
 * `meeting_key` column exists, so none of those appear here. This is
 * enough for the loader either way — `sessionFieldsFromRaw` reads
 * `session_name` for the session's name (never falling back to
 * `session_type`, since this always supplies `session_name` directly) and
 * touches no other missing field; only `meeting_name` is permanently
 * unrecoverable from a dump (it depends on `meeting_key`, resolved once at
 * load time and not stored back onto the row).
 */
export function sessionRawFromRow(row: DumpSessionRow): RawRecord {
  const raw: RawRecord = {
    session_key: Number(row.sessionKey),
    session_name: row.name,
    country_name: row.country,
    circuit_key: row.circuitKey,
    date_start: row.dateStart.toISOString(),
    date_end: row.dateEnd.toISOString(),
  };
  if (row.circuitShortName !== null) raw["circuit_short_name"] = row.circuitShortName;
  if (row.location !== null) raw["location"] = row.location;
  return raw;
}

/**
 * Writes one `raw/<endpoint>.jsonl` line per row, paged by `seq` — rows from
 * one page are grouped by endpoint and appended immediately, so no page's
 * rows are held past the loop iteration that fetched them, and the whole
 * race is never in memory at once. Within one endpoint's file, line order
 * is `seq` order — which is also `received_at` order, since the single
 * writer that produced these rows commits in `seq` order (ADR-0007) — the
 * order the round-trip invariant depends on.
 */
async function writeEventPages(
  db: DumpDb,
  sessionKey: bigint,
  rawDir: string,
): Promise<{ events: number; endpoints: string[] }> {
  const endpointsSeen = new Set<string>();
  let cursor = 0n;
  let total = 0;

  for (;;) {
    const page = await db.event.findMany({
      where: { sessionKey, seq: { gt: cursor } },
      orderBy: { seq: "asc" },
      take: PAGE_SIZE,
      select: { seq: true, endpoint: true, receivedAt: true, payload: true },
    });
    if (page.length === 0) break;

    const byEndpoint = new Map<string, string[]>();
    for (const row of page) {
      const line = JSON.stringify({ received_at: row.receivedAt.toISOString(), payload: row.payload });
      const lines = byEndpoint.get(row.endpoint) ?? [];
      lines.push(line);
      byEndpoint.set(row.endpoint, lines);
    }
    for (const [endpoint, lines] of byEndpoint) {
      endpointsSeen.add(endpoint);
      await appendFile(path.join(rawDir, `${endpoint}.jsonl`), lines.join("\n") + "\n");
    }

    total += page.length;
    cursor = page[page.length - 1]!.seq;
    if (page.length < PAGE_SIZE) break;
  }

  return { events: total, endpoints: [...endpointsSeen] };
}

export interface DumpRecordingOptions {
  now?: () => number;
  onLog?: (line: string) => void;
  /** Overwrite an `--out` directory that already carries `polls.jsonl` (a real recording) instead of refusing it. */
  force?: boolean;
}

export interface DumpRecordingResult {
  found: boolean;
  events: number;
  endpoints: string[];
}

/**
 * Reads one session back out of Postgres into the recording layout the
 * loader and the drip simulator read. Two guards, checked before any write:
 * an `--out` directory already carrying `polls.jsonl` (a real recording) is
 * refused unless `force`; an unknown `session_key` is refused too. Either
 * refusal writes nothing.
 */
export async function dumpRecording(
  sessionKey: bigint,
  db: DumpDb,
  outDir: string,
  opts: DumpRecordingOptions = {},
): Promise<DumpRecordingResult> {
  const log = opts.onLog ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  const force = opts.force ?? false;
  const refused: DumpRecordingResult = { found: false, events: 0, endpoints: [] };

  const pollsPath = path.join(outDir, "polls.jsonl");
  if (!force) {
    try {
      await stat(pollsPath);
      log(
        `dump: refused ${sessionKey}: ${outDir} already holds polls.jsonl (a real recording); pass --force to overwrite`,
      );
      return refused;
    } catch {
      // No polls.jsonl: outDir is empty, doesn't exist yet, or holds an
      // earlier dump (dump-recording never writes anything but an empty
      // polls.jsonl, so a prior dump's own output is always safe to redo).
    }
  }

  const session = await db.session.findUnique({ where: { sessionKey } });
  if (session === null) {
    log(`dump: refused ${sessionKey}: no session found`);
    return refused;
  }

  // `raw/<endpoint>.jsonl` is written by appending pages, not by one
  // whole-file write like session.json/polls.jsonl below — so a rerun (a
  // retry after a crash, or a --force re-dump) must start from an empty
  // raw/ or its appends land on top of the previous run's lines instead of
  // replacing them.
  const rawDir = path.join(outDir, "raw");
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });

  await writeFile(
    path.join(outDir, "session.json"),
    JSON.stringify(
      { session: sessionRawFromRow(session), discovered_at: new Date(now()).toISOString() },
      null,
      2,
    ) + "\n",
  );

  const { events, endpoints } = await writeEventPages(db, sessionKey, rawDir);

  // Always empty: this command has no polls to replay, and the file's mere
  // presence is what the simulator's guard checks for.
  await writeFile(pollsPath, "");

  if (events === 0) {
    log(`dump: session ${sessionKey} has no events; wrote session.json and empty files`);
  } else {
    log(`dump: session=${sessionKey} events=${events} endpoints=${endpoints.length} out=${outDir}`);
  }

  return { found: true, events, endpoints };
}

// CLI entry: `node dist/dump-recording.js [--force] <session_key> [--out
// <dir>]` (package.json script "dump"; root script "ingest:dump"). Guarded
// so this module can be imported by the unit test without running the CLI.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const withoutForce = argv.filter((arg) => arg !== "--force");
  const outIndex = withoutForce.indexOf("--out");
  let outDir: string | undefined;
  let positional = withoutForce;
  if (outIndex !== -1) {
    outDir = withoutForce[outIndex + 1];
    positional = [...withoutForce.slice(0, outIndex), ...withoutForce.slice(outIndex + 2)];
  }

  const sessionKeyArg = positional[0];
  if (!sessionKeyArg || !/^\d+$/.test(sessionKeyArg)) {
    console.error("dump-recording: usage: pnpm ingest:dump [--force] <session_key> [--out <dir>]");
    process.exit(1);
  }

  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("dump-recording: DATABASE_URL is not set; refusing to start (ADR-0004 config seam).");
    process.exit(1);
  }

  const db = createDb(config.databaseUrl, { max: 1 });
  const resolvedOutDir = outDir ?? path.join("recordings", sessionKeyArg);

  dumpRecording(BigInt(sessionKeyArg), db, resolvedOutDir, { force })
    .then(async (result) => {
      await db.$disconnect();
      process.exit(result.found ? 0 : 1);
    })
    .catch(async (error: unknown) => {
      console.error(`dump-recording: failed: ${error instanceof Error ? error.message : String(error)}`);
      await db.$disconnect();
      process.exit(1);
    });
}
