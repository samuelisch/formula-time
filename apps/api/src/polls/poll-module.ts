// PollModule is the only writer of `polls` and `votes` (apps/api/AGENTS.md,
// ADR-0001 §2 invariant 5): "Anything with stakes (votes, settlement)
// settles server-side, never in the browser. A vote is acknowledged only
// after its insert commits."
//
// Lock / resolve / void all follow the same rule: the Postgres write lands
// first, and only once it resolves does the in-memory status change. A vote
// that commits before a lock write is valid and must be in the tally; a
// vote that races the write and loses gets 0 rows from vote-path's
// conditional upsert (see vote-path.ts for why that check lives inside the
// write rather than before it).
import type { Prisma, PrismaClient } from "@formula-time/db";
import { isChequered, leaderLap } from "@formula-time/domain";
import type { RaceState } from "@formula-time/domain";
import { locksAtLap } from "@formula-time/domain";

import { upsertVote } from "./vote-path.js";

export type PollTemplateKind = "winner" | "podium";
export type PollLifecycleStatus = "open" | "locked" | "resolved" | "void";

export interface PollOptionPublic {
  id: string;
  label: string;
}

export interface PollPublic {
  poll_id: string;
  kind: PollTemplateKind;
  question: string;
  options: PollOptionPublic[];
  locks_at_lap: number;
  status: PollLifecycleStatus;
  tally: Record<string, number>;
  total_votes: number;
  winning_option_ids: string[] | null;
}

export type VoteResult =
  | { ok: true; poll: PollPublic; option_id: string }
  | { ok: false; status: 404 | 400 | 409; error: string };

export interface PollModuleLogger {
  info(msg: string): void;
}

interface InternalPoll {
  pollId: string;
  kind: PollTemplateKind;
  question: string;
  options: PollOptionPublic[];
  locksAtLap: number;
  status: PollLifecycleStatus;
  votes: Map<string, string>; // viewerId -> optionId; upsert = structural dedup
  winningOptionIds: string[] | null;
}

interface ActiveSession {
  sessionKey: bigint;
  totalLaps: number | null;
  country: string;
}

function kindFromPollId(pollId: string): PollTemplateKind {
  return pollId.endsWith(":podium") ? "podium" : "winner";
}

function toPublic(poll: InternalPoll): PollPublic {
  const tally: Record<string, number> = {};
  for (const optionId of poll.votes.values()) {
    tally[optionId] = (tally[optionId] ?? 0) + 1;
  }
  return {
    poll_id: poll.pollId,
    kind: poll.kind,
    question: poll.question,
    options: poll.options,
    locks_at_lap: poll.locksAtLap,
    status: poll.status,
    tally,
    total_votes: poll.votes.size,
    winning_option_ids: poll.winningOptionIds,
  };
}

export class PollModule {
  private readonly db: PrismaClient;
  private readonly log: PollModuleLogger;
  private readonly polls = new Map<string, InternalPoll>();
  private session: ActiveSession | null = null;
  private loggedNoTotalLaps = false;
  // onState must be synchronous-safe (called from the projector's tick); its
  // own DB writes are serialised through this promise chain instead.
  private writeChain: Promise<void> = Promise.resolve();
  // Per-viewer vote serialization (see vote()'s comment): one chain per
  // viewer currently mid-vote; absent once that viewer's votes have drained.
  private readonly voteChains = new Map<string, Promise<VoteResult>>();

  public constructor(opts: { db: PrismaClient; log: PollModuleLogger }) {
    this.db = opts.db;
    this.log = opts.log;
  }

  public async start(session: ActiveSession): Promise<void> {
    this.session = session;
    this.polls.clear();
    this.loggedNoTotalLaps = false;

    const rows = await this.db.poll.findMany({ where: { sessionKey: session.sessionKey } });
    if (rows.length === 0) return;

    const pollIds = rows.map((row) => row.pollId);
    const voteRows = await this.db.vote.findMany({ where: { pollId: { in: pollIds } } });

    const votesByPoll = new Map<string, Map<string, string>>();
    for (const vote of voteRows) {
      const map = votesByPoll.get(vote.pollId) ?? new Map<string, string>();
      map.set(vote.viewerId, vote.optionId);
      votesByPoll.set(vote.pollId, map);
    }

    for (const row of rows) {
      this.polls.set(row.pollId, {
        pollId: row.pollId,
        kind: kindFromPollId(row.pollId),
        question: row.question,
        options: row.options as unknown as PollOptionPublic[],
        locksAtLap: row.locksAtLap,
        status: row.status,
        votes: votesByPoll.get(row.pollId) ?? new Map(),
        winningOptionIds: (row.winningOptionIds as unknown as string[] | null) ?? null,
      });
    }
  }

  /** Called from the projector's single authority subscription. Schedules
   * its own writes; the returned promise resolves once this state's fold
   * (and everything queued before it) has landed, so a caller that publishes
   * poll state can wait for it. Never rejects: failures are logged. */
  public onState(state: RaceState): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.applyState(state)).catch((err) => this.logWriteFailure(err));
    return this.writeChain;
  }

  /** Test-only: resolves once every write scheduled by onState() so far has landed. */
  public async waitForIdle(): Promise<void> {
    await this.writeChain;
  }

  private logWriteFailure(err: unknown): void {
    // The chain must always resolve: an unhandled rejection here would
    // poison it forever, and each write is already retryable on the next
    // tick since every updateMany in this file is conditional on the
    // poll's current status rather than assuming success.
    this.log.info(`poll write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Routed through the same writeChain as onState: an unchained write here
  // could race a queued lock (or resolve) for the same poll — the void's
  // conditional updateMany would read a stale in-memory status, miss the
  // row a concurrent write just changed, and leave the poll stuck instead
  // of voided. Chaining guarantees anything already queued lands first.
  public async onSessionFinished(): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => this.voidFinishedPolls())
      .catch((err) => this.logWriteFailure(err));
    await this.writeChain;
  }

  private async voidFinishedPolls(): Promise<void> {
    for (const poll of this.polls.values()) {
      if (poll.status !== "open" && poll.status !== "locked") continue;
      const result = await this.db.poll.updateMany({
        where: { pollId: poll.pollId, status: poll.status },
        data: { status: "void" },
      });
      if (result.count > 0) {
        poll.status = "void";
      }
    }
  }

  public publicPolls(): PollPublic[] {
    return Array.from(this.polls.values(), toPublic);
  }

  // Two concurrent votes from the same viewer race: Postgres decides which
  // option is stored last by commit order, but without serialization here,
  // poll.votes.set(viewerId, ...) below would run in whichever order the
  // two promises happen to resolve in on this process — not necessarily
  // the DB's commit order — so memory could end up disagreeing with the
  // table (CI caught this as tally drift under a same-viewer burst).
  //
  // A vote for a viewer waits for that viewer's previous vote (upsert and
  // memory update both) to finish before starting; votes from different
  // viewers still run fully concurrently. One process holds all votes
  // (ADR-0001 §1), so this per-viewer ordering is authoritative — nothing
  // else writes `votes`.
  public vote(pollId: string, viewerId: string, optionId: string): Promise<VoteResult> {
    const previous = this.voteChains.get(viewerId) ?? Promise.resolve();
    const chained: Promise<VoteResult> = previous.then(
      () => this.voteOnce(pollId, viewerId, optionId),
      () => this.voteOnce(pollId, viewerId, optionId),
    );
    // Only clear the entry if nothing newer has been chained after this
    // vote — a later call for the same viewer may already have replaced it.
    const tracked = chained.finally(() => {
      if (this.voteChains.get(viewerId) === tracked) {
        this.voteChains.delete(viewerId);
      }
    });
    this.voteChains.set(viewerId, tracked);
    return tracked;
  }

  private async voteOnce(pollId: string, viewerId: string, optionId: string): Promise<VoteResult> {
    const poll = this.polls.get(pollId);
    if (poll === undefined) {
      return { ok: false, status: 404, error: `unknown poll ${pollId}` };
    }
    if (!poll.options.some((option) => option.id === optionId)) {
      return { ok: false, status: 400, error: `unknown option ${optionId}` };
    }
    if (poll.status !== "open") {
      return { ok: false, status: 409, error: "poll is locked" };
    }

    // Fast reject above is only a hint; the conditional upsert below is the
    // truth (see vote-path.ts). A returned row means the vote counted, and
    // memory is set from the option_id Postgres actually stored — never
    // from this call's own `optionId` argument — because the per-viewer
    // chain above only rules out this process racing itself; the value
    // Postgres returns is still the one fact that matches the committed
    // row. Only after it resolves is the vote acknowledged to the caller.
    const storedOptionId = await upsertVote(this.db, pollId, viewerId, optionId);
    if (storedOptionId === null) {
      return { ok: false, status: 409, error: "poll is locked" };
    }

    poll.votes.set(viewerId, storedOptionId);
    return { ok: true, poll: toPublic(poll), option_id: storedOptionId };
  }

  private async applyState(state: RaceState): Promise<void> {
    if (this.session === null) return;

    if (this.polls.size === 0) {
      if (Object.keys(state.drivers).length === 0) return;
      if (this.session.totalLaps === null) {
        if (!this.loggedNoTotalLaps) {
          this.log.info("polls not opened: total_laps unknown");
          this.loggedNoTotalLaps = true;
        }
        return;
      }
      await this.openPolls(state, this.session.totalLaps, this.session.country, this.session.sessionKey);
    }

    const lap = leaderLap(state);
    await this.lockDuePolls(lap);

    if (isChequered(state) && state.driver_order.length > 0) {
      await this.resolvePolls(state.driver_order);
    }
  }

  private async openPolls(
    state: RaceState,
    totalLaps: number,
    country: string,
    sessionKey: bigint,
  ): Promise<void> {
    const options: PollOptionPublic[] = Object.values(state.drivers)
      .sort((left, right) => left.driver_number - right.driver_number)
      .map((driver) => ({
        id: String(driver.driver_number),
        label: driver.name_acronym ?? driver.full_name ?? `#${driver.driver_number}`,
      }));
    const locks = locksAtLap("race-result", { totalLaps });

    const templates: InternalPoll[] = [
      {
        pollId: `${sessionKey}:winner`,
        kind: "winner",
        question: `Who wins the ${country} GP?`,
        options,
        locksAtLap: locks,
        status: "open",
        votes: new Map(),
        winningOptionIds: null,
      },
      {
        pollId: `${sessionKey}:podium`,
        kind: "podium",
        question: `Pick a driver to finish on the podium of the ${country} GP`,
        options,
        locksAtLap: locks,
        status: "open",
        votes: new Map(),
        winningOptionIds: null,
      },
    ];

    await this.db.poll.createMany({
      data: templates.map((template) => ({
        pollId: template.pollId,
        sessionKey,
        question: template.question,
        options: template.options as unknown as Prisma.InputJsonValue,
        locksAtLap: template.locksAtLap,
        status: "open",
      })),
      skipDuplicates: true,
    });

    for (const template of templates) {
      this.polls.set(template.pollId, template);
    }
  }

  private async lockDuePolls(lap: number): Promise<void> {
    for (const poll of this.polls.values()) {
      if (poll.status !== "open" || lap < poll.locksAtLap) continue;
      const result = await this.db.poll.updateMany({
        where: { pollId: poll.pollId, status: "open" },
        data: { status: "locked" },
      });
      if (result.count > 0) {
        poll.status = "locked";
      }
    }
  }

  private async resolvePolls(driverOrder: number[]): Promise<void> {
    const order = driverOrder.map(String);
    for (const poll of this.polls.values()) {
      // void is terminal (owner ruling, 2026-09-08): a chequered tick after
      // a poll has been voided must never resurrect it.
      if (poll.status === "resolved" || poll.status === "void") continue;
      const winningOptionIds = poll.kind === "winner" ? order.slice(0, 1) : order.slice(0, 3);
      const result = await this.db.poll.updateMany({
        where: { pollId: poll.pollId, status: poll.status },
        data: { status: "resolved", winningOptionIds, resolvedAt: new Date() },
      });
      if (result.count > 0) {
        poll.status = "resolved";
        poll.winningOptionIds = winningOptionIds;
      }
    }
  }
}
