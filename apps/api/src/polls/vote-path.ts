// Why the status check lives inside the write, not before it.
//
// If the route read "status is open" and then inserted, the poll could lock
// between those two steps and a late vote would be counted. So the
// in-memory status check in `PollModule.vote` is only a fast reject; the
// truth is this one conditional upsert, whose row count Postgres decides
// atomically inside a single statement. Only a row count of 1 changes the
// tally.
//
// The statement, verbatim:
//
//   INSERT INTO votes (poll_id, viewer_id, option_id, voted_at)
//   SELECT $1, $2::uuid, $3, now()
//   WHERE EXISTS (SELECT 1 FROM polls WHERE poll_id = $1 AND status = 'open')
//   ON CONFLICT (poll_id, viewer_id) DO UPDATE
//     SET option_id = EXCLUDED.option_id, voted_at = EXCLUDED.voted_at
//
// Below, via `db.$executeRaw` (tagged template — the parameters are bound,
// never interpolated); the template's placeholders are Prisma's `$1`/`$2`/`$3`
// equivalents for `pollId`/`viewerId`/`optionId`.
import type { PrismaClient } from "@formula-time/db";

/** Row count 0 means the poll was not open at commit time; 1 means the vote counted. */
export async function upsertVote(
  db: PrismaClient,
  pollId: string,
  viewerId: string,
  optionId: string,
): Promise<number> {
  return db.$executeRaw`
    INSERT INTO votes (poll_id, viewer_id, option_id, voted_at)
    SELECT ${pollId}, ${viewerId}::uuid, ${optionId}, now()
    WHERE EXISTS (SELECT 1 FROM polls WHERE poll_id = ${pollId} AND status = 'open')
    ON CONFLICT (poll_id, viewer_id) DO UPDATE
      SET option_id = EXCLUDED.option_id, voted_at = EXCLUDED.voted_at
  `;
}
