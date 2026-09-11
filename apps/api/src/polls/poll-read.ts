// The shared PollPublic shape and its build logic. Both the live/in-memory
// path (poll-module.ts, folded from RaceState) and the read path for
// `GET /api/races/:session_key/polls` (routes.ts, read straight from
// Postgres) produce the same wire shape from here, so they cannot drift.
//
// pollsBySession is the read path itself: two queries per request, never
// per viewer per tick (ADR-0001 §2 invariant 2) -- one `poll.findMany` for
// the session's rows, one `vote.groupBy` for their tallies.
import type { PrismaClient } from "@formula-time/db";
import type { PollLifecycleStatus, PollOptionPublic, PollPublic, PollTemplateKind } from "@formula-time/domain";

export type { PollLifecycleStatus, PollOptionPublic, PollPublic, PollTemplateKind };

export function kindFromPollId(pollId: string): PollTemplateKind {
  return pollId.endsWith(":podium") ? "podium" : "winner";
}

/** The fields toPublic needs to build a PollPublic. poll-module.ts's
 * in-memory InternalPoll and a Prisma Poll row both satisfy this
 * structurally, so one function builds the wire shape for both. */
export interface PollFields {
  pollId: string;
  question: string;
  options: PollOptionPublic[];
  locksAtLap: number;
  status: PollLifecycleStatus;
  winningOptionIds: string[] | null;
}

export function toPublic(poll: PollFields, tally: Record<string, number>): PollPublic {
  let totalVotes = 0;
  for (const count of Object.values(tally)) {
    totalVotes += count;
  }
  return {
    poll_id: poll.pollId,
    kind: kindFromPollId(poll.pollId),
    question: poll.question,
    options: poll.options,
    locks_at_lap: poll.locksAtLap,
    status: poll.status,
    tally,
    total_votes: totalVotes,
    winning_option_ids: poll.winningOptionIds,
  };
}

export interface PollsBySessionResult {
  polls: PollPublic[];
  /** True once every poll of the session is `resolved` or `void` -- the
   * route's cache-control decision (computed from the rows, never from a
   * lookup on `sessions`). False for an empty result too: with no rows we
   * cannot tell an unknown session from one still upcoming. */
  cacheable: boolean;
}

/** Read path for `GET /api/races/:session_key/polls`. An unknown or
 * poll-less session answers `{ polls: [], cacheable: false }` -- no lookup
 * on `sessions`. */
export async function pollsBySession(db: PrismaClient, sessionKey: bigint): Promise<PollsBySessionResult> {
  const rows = await db.poll.findMany({ where: { sessionKey } });
  if (rows.length === 0) {
    return { polls: [], cacheable: false };
  }

  const pollIds = rows.map((row) => row.pollId);
  const grouped = await db.vote.groupBy({
    by: ["pollId", "optionId"],
    where: { pollId: { in: pollIds } },
    _count: true,
  });

  const talliesByPoll = new Map<string, Record<string, number>>();
  for (const group of grouped) {
    const tally = talliesByPoll.get(group.pollId) ?? {};
    tally[group.optionId] = group._count;
    talliesByPoll.set(group.pollId, tally);
  }

  const polls = rows.map((row) =>
    toPublic(
      {
        pollId: row.pollId,
        question: row.question,
        options: row.options as unknown as PollOptionPublic[],
        locksAtLap: row.locksAtLap,
        status: row.status,
        winningOptionIds: (row.winningOptionIds as unknown as string[] | null) ?? null,
      },
      talliesByPoll.get(row.pollId) ?? {},
    ),
  );

  const cacheable = rows.every((row) => row.status === "resolved" || row.status === "void");
  return { polls, cacheable };
}
