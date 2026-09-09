// Which session the projector folds. `sessions` holds the whole season
// calendar (ingest discovery upserts every row `sessions?year=` returns),
// so "the greatest dateStart" is not "the next session" -- it is whichever
// race is latest on the calendar, live or not. The rule (measured against
// the deployed database 2026-09-09, 131 rows: 81 finished, 50 upcoming):
// "Pick, in order: the `live` session with the latest `dateStart`; else
// the `upcoming` session with the SMALLEST `dateStart` whose `dateEnd` + 30
// minutes is still in the future (the next session on the calendar); else
// the `finished` session with the greatest `dateStart` (the most recent
// race, so the fold has something to serve)." `now` is injected so tests
// are deterministic. Restart always resolves the same way -- there is no
// persisted "current session" state.
import type { PrismaClient, Session } from "@formula-time/db";

const GRACE_MS = 30 * 60 * 1000;

export async function pickSession(db: PrismaClient, now: () => number = () => Date.now()): Promise<Session | null> {
  const live = await db.session.findFirst({
    where: { status: "live" },
    orderBy: { dateStart: "desc" },
  });
  if (live !== null) {
    return live;
  }

  const cutoff = new Date(now() - GRACE_MS);
  const upcoming = await db.session.findFirst({
    where: { status: "upcoming", dateEnd: { gte: cutoff } },
    orderBy: { dateStart: "asc" },
  });
  if (upcoming !== null) {
    return upcoming;
  }

  const finished = await db.session.findFirst({
    where: { status: "finished" },
    orderBy: { dateStart: "desc" },
  });
  return finished ?? null;
}
