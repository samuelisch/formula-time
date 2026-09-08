// Which session the projector folds: the live one, or (nothing live) the
// most recent by dateStart. Restart always resolves the same way — there is
// no persisted "current session" state.
import type { PrismaClient, Session } from "@formula-time/db";

export async function pickSession(db: PrismaClient): Promise<Session | null> {
  const live = await db.session.findFirst({
    where: { status: "live" },
    orderBy: { dateStart: "desc" },
  });
  if (live !== null) {
    return live;
  }

  const latest = await db.session.findFirst({
    orderBy: { dateStart: "desc" },
  });
  return latest ?? null;
}
