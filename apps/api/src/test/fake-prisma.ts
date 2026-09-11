// Typed fake for the pickSession seam: a plain array of sessions served
// through the same `SessionsDb` interface (projector/session-picker.ts)
// production code is narrowed to, so no cast to the full PrismaClient is
// needed.
import type { Session } from "@formula-time/db";

import type { SessionsDb } from "../projector/session-picker.js";

export function fakePrisma(sessions: Session[] = []): SessionsDb {
  return {
    session: {
      async findFirst(args) {
        let pool = sessions;
        if (args.where.status !== undefined) {
          pool = pool.filter((s) => s.status === args.where.status);
        }
        if (args.where.dateEnd !== undefined) {
          const cutoff = args.where.dateEnd.gte;
          pool = pool.filter((s) => s.dateEnd.getTime() >= cutoff.getTime());
        }
        const sorted = [...pool].sort((a, b) =>
          args.orderBy.dateStart === "desc"
            ? b.dateStart.getTime() - a.dateStart.getTime()
            : a.dateStart.getTime() - b.dateStart.getTime(),
        );
        return sorted[0] ?? null;
      },
    },
  };
}
