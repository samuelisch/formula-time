// The status check lives inside the write: a separate read-then-insert
// could let the poll lock between the two steps and still count a late
// vote, so the truth is this one conditional upsert -- a returned row
// means the vote counted. The tally is set from the option_id this
// statement returns, never the caller's argument, since Postgres decides
// a same-viewer race by commit order. See README: Polls.
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
