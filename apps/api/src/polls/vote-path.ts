// Why the status check lives inside the write, not before it.
//
// If the route read "status is open" and then inserted, the poll could lock
// between those two steps and a late vote would be counted. So the
// in-memory status check in `PollModule.vote` is only a fast reject; the
// truth is this one conditional upsert. A returned row means the vote
// counted; no row means the poll was not open at commit time.
//
// RETURNING option_id also settles a second race: two concurrent votes
// from the *same* viewer. Postgres decides which option is stored last by
// commit order, not by which of two racing JS promises happens to resolve
// first on this process — so the in-memory tally is set from the value
// this statement returns, never from the caller's own `optionId` argument
// (CI caught the drift this produces if memory is set optimistically).
// `PollModule.vote` additionally serializes votes per viewer so the two
// concerns don't compound.
//
// The statement, verbatim:
//
//   INSERT INTO votes (poll_id, viewer_id, option_id, voted_at)
//   SELECT $1, $2::uuid, $3, now()
//   WHERE EXISTS (SELECT 1 FROM polls WHERE poll_id = $1 AND status = 'open')
//   ON CONFLICT (poll_id, viewer_id) DO UPDATE
//     SET option_id = EXCLUDED.option_id, voted_at = EXCLUDED.voted_at
//   RETURNING option_id
//
// Below, via `db.$queryRaw` (tagged template — the parameters are bound,
// never interpolated); the template's placeholders are Prisma's `$1`/`$2`/`$3`
// equivalents for `pollId`/`viewerId`/`optionId`.
import type { PrismaClient } from "@formula-time/db";

/** The option_id Postgres actually stored, or null if the poll was not open at commit time (no row). */
export async function upsertVote(
  db: PrismaClient,
  pollId: string,
  viewerId: string,
  optionId: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ option_id: string }>>`
    INSERT INTO votes (poll_id, viewer_id, option_id, voted_at)
    SELECT ${pollId}, ${viewerId}::uuid, ${optionId}, now()
    WHERE EXISTS (SELECT 1 FROM polls WHERE poll_id = ${pollId} AND status = 'open')
    ON CONFLICT (poll_id, viewer_id) DO UPDATE
      SET option_id = EXCLUDED.option_id, voted_at = EXCLUDED.voted_at
    RETURNING option_id
  `;
  return rows[0]?.option_id ?? null;
}
