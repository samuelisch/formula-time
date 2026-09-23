// Which session the projector folds; the algorithm is in README: Which
// session is served. `now` is injected so tests are deterministic;
// restart always resolves the same way since there is no persisted
// "current session" state.
import type { Session } from "@formula-time/db";

const GRACE_MS = 30 * 60 * 1000;

/** The slice of `PrismaClient` this module actually calls -- narrower than
 * the full client so a test can hand it a plain in-memory fake instead of a
 * live database (apps/api/AGENTS.md "Postgres is touched ... never per
 * viewer", unrelated here but the same narrowing habit). */
export interface SessionsDb {
  session: {
    findFirst(args: {
      where: { status: Session["status"]; dateEnd?: { gte: Date } };
      orderBy: { dateStart: "asc" | "desc" };
    }): Promise<Session | null>;
  };
}

export async function pickSession(db: SessionsDb, now: () => number = () => Date.now()): Promise<Session | null> {
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
