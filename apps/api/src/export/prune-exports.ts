// One-off maintenance command (owner-run, apps/api/AGENTS.md): deletes the
// file and row for an `exports` entry whose session has no non-`drivers`
// event. Dry-run by default; `--apply` deletes. See README: Exports.
import { unlink } from "node:fs/promises";

import { createDb, type PrismaClient } from "@formula-time/db";

export type PruneLog = (msg: string) => void;

export interface PruneOptions {
  db: PrismaClient;
  /** false (default): log what would be pruned, change nothing. */
  apply: boolean;
  log: PruneLog;
}

export interface PruneSummary {
  checked: number;
  pruned: number;
}

/** For every `exports` row whose session has no non-`drivers` event,
 * delete the file (best-effort -- a file already missing is not an error,
 * ADR-0009 §3 "disk is a cache") and the row. Logs each pruned key, then a
 * one-line summary. */
export async function runPrune(opts: PruneOptions): Promise<PruneSummary> {
  const { db, apply, log } = opts;
  const rows = await db.export.findMany({ select: { sessionKey: true, path: true } });

  let pruned = 0;
  for (const { sessionKey, path } of rows) {
    const timingEvent = await db.event.findFirst({
      where: { sessionKey, endpoint: { not: "drivers" } },
      select: { seq: true },
    });
    if (timingEvent !== null) continue;

    const key = sessionKey.toString();
    log(apply ? `pruning export ${key}` : `would prune export ${key}`);
    if (apply) {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await db.export.delete({ where: { sessionKey } });
    }
    pruned++;
  }

  log(
    apply
      ? `pruned ${pruned.toString()} of ${rows.length.toString()} exports`
      : `would prune ${pruned.toString()} of ${rows.length.toString()} exports (dry run -- pass --apply to delete)`,
  );
  return { checked: rows.length, pruned };
}

/* Entry point -- exercised manually inside the container, not by tests. */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = createDb();
  try {
    await runPrune({ db, apply, log: (msg) => console.log(msg) });
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
