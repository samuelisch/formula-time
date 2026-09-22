// Picks the session to serve, starts its projector, wires it to the poll
// module and the fan-out, and refreshes the session row on every check.
// ADR-0033 has the reasoning.
import type { Session } from "@formula-time/db";
import type { PollPublic, RaceState, RawRecord, StatePush } from "@formula-time/domain";

import type { EventSource } from "./event-source.js";
import { RaceStateProjector, type ProjectorLog } from "./projector.js";
import type { SessionsDb } from "./session-picker.js";

export interface HealthResponse {
  ok: true;
  session_key: string | null;
  cursor: string;
  caught_up: boolean;
  viewers: number;
}

export interface Pusher {
  push(payload: object): Promise<void>;
  size(): number;
}

// The poll module's lifecycle hooks, as seen from serve-session: it
// folds from the same authority state as the projector (apps/api/AGENTS.md
// "The poll module"), so start/onSessionFinished are sequenced around the
// projector here rather than left for PollModule to discover on its own.
export interface PollHooks {
  start(session: {
    sessionKey: bigint;
    totalLaps: number | null;
    country: string;
    meetingName: string | null;
  }): Promise<void>;
  /** Resolves once this state's fold has landed; the push waits for it. */
  onState(state: RaceState): Promise<void>;
  onSessionFinished(): Promise<void>;
  publicPolls(): unknown[];
  /** A total_laps or meeting_name refreshed on a lifecycle check without a
   * session-key change (the circuits table case): merged in-memory, no
   * Postgres write, so it takes effect on the poll module's next tick. */
  updateSession(update: { totalLaps: number | null; meetingName: string | null }): void;
}

export interface SessionLifecycleOptions {
  db: SessionsDb;
  source: EventSource;
  pusher: Pusher;
  pickSession: (db: SessionsDb) => Promise<Session | null>;
  polls: PollHooks;
  log: ProjectorLog;
}

export interface SessionLifecycle {
  /** Re-run pickSession; on a changed session key, stop the old projector
   * (if any) and start a fresh fold from cursor 0 (HLD §7 "Cursor"). */
  check(): Promise<void>;
  /** The /health response shape -- session_key null / cursor "0" /
   * caught_up false while no session has been found yet. */
  health(): HealthResponse;
  /** Stop the current projector, if one is running. Safe to call with none. */
  stop(): void;
}

export function createSessionLifecycle(opts: SessionLifecycleOptions): SessionLifecycle {
  let session: Session | null = null;
  let projector: RaceStateProjector | null = null;
  let warnedNoSession = false;
  // Tracks whether polls.onSessionFinished() has already fired for the
  // session currently held in `session`, so a status flip to "finished"
  // notifies exactly once per session (part (c) of the wiring contract).
  let finishedNotified = false;
  // check() now awaits DB round trips (pickSession, polls.start,
  // polls.onSessionFinished); main.ts fires it on a fixed interval, so a
  // slow tick must not overlap the next one.
  let checking = false;

  // The pushed payload's top-level total_laps must come from the same
  // session read as the state it accompanies: a push is built after an
  // await (the poll fold), and the projector's session can move in that
  // gap, so reading it live here rather than from this frame's own
  // `state.session` could disagree with the state this same frame carries.
  function totalLapsFromSession(session: RawRecord | null): number | null {
    if (session === null) return null;
    const value = session["total_laps"];
    return typeof value === "number" ? value : null;
  }

  function logPollHookFailure(hook: string, err: unknown): void {
    opts.log(`poll hook ${hook} failed`, { error: err instanceof Error ? err.message : String(err) });
  }

  /** Void the current session's polls, once per session. Safe to call again. */
  async function notifyFinished(): Promise<void> {
    if (finishedNotified) return;
    finishedNotified = true;
    try {
      await opts.polls.onSessionFinished();
    } catch (err) {
      logPollHookFailure("onSessionFinished", err);
    }
  }

  function wireProjector(p: RaceStateProjector, forSession: Session): void {
    // A rejected push (below) means this class cannot know whether any
    // client actually saw that tick's events -- the same situation as a
    // fan-out-level skipped frame. Written only in the .catch() below, and
    // consumed (read, then cleared) only where the next payload is built --
    // never reset anywhere else. Ticks run on a fixed interval regardless
    // of whether the previous tick's push has settled, so if push N is
    // still in flight when N+1's payload is built, N+1 goes out without
    // `rebuilt` and N's rejection is only observed afterward: the
    // guarantee is that the first payload built once the rejection *is*
    // observed carries `rebuilt: true` -- N+2 at the latest (the tick
    // interval vastly exceeds a promise settling), never later -- and no
    // payload built after that point goes out without it.
    let skippedSinceLastPush = false;

    p.subscribe((state, cursor, events, rebuilt) => {
      // The poll module folds from the same authority state before the one
      // serialize: a push must never carry a stale lock. onState() only
      // schedules the fold, so the push waits for it. Folds are a FIFO
      // chain and this continuation is registered before the next tick can
      // queue its own, so push N always sees exactly fold N.
      void opts.polls
        .onState(state)
        .then(() => {
          // `events` is the RaceEvent rows the projector applied this tick, in
          // seq order (`[]` when none) -- a client folds them into its own
          // deep-rewind timeline rather than the api building one server-side.
          // `rebuilt` rides along when the late-commit detector's rebuild
          // produced this push, or this projector's previous push was
          // rejected or skipped by the fan-out (a deflate error, e.g.) --
          // in either case the client must discard its timeline and
          // backfill again, since a tick's events may have reached no one.
          // It is omitted -- rather than sent as `false` -- on every
          // ordinary tick.
          const payload: StatePush = {
            type: "state",
            seq: cursor.toString(),
            sent_at: Date.now(),
            session_key: forSession.sessionKey.toString(),
            // Read from this frame's own state, not the projector's live
            // session: the projector's session can move between this
            // callback firing and onState()'s await resolving, and this
            // field must never disagree with the state this same frame
            // carries.
            total_laps: totalLapsFromSession(state.session),
            state,
            // PollHooks.publicPolls() stays `unknown[]` (a test fake exercises
            // tick sequencing with placeholder poll objects, not the real
            // shape); the real implementation always returns `PollPublic[]`.
            polls: opts.polls.publicPolls() as PollPublic[],
            events,
          };
          if (rebuilt || skippedSinceLastPush) {
            payload.rebuilt = true;
          }
          skippedSinceLastPush = false;
          return opts.pusher.push(payload);
        })
        .catch((err) => {
          // A push failure (a deflate write error, a socket destroyed
          // mid-write) must never reach an unhandled rejection: on Node 24
          // that kills the process. The next tick pushes the next state;
          // the socket that caused the failure is already dropped by the
          // fan-out's own write loop. This tick's events reached no
          // client, so the next push actually attempted is marked
          // rebuilt: true above.
          skippedSinceLastPush = true;
          const message = err instanceof Error ? err.message : String(err);
          opts.log("push failed", { level: "error", cursor: cursor.toString(), error: message });
        });
    });
    p.start();
  }

  async function runCheck(): Promise<void> {
      const candidate = await opts.pickSession(opts.db);
      if (candidate === null) {
        if (!warnedNoSession) {
          opts.log("no session found (upcoming, live, or finished) -- waiting");
          warnedNoSession = true;
        }
        return;
      }

      if (session !== null && candidate.sessionKey === session.sessionKey) {
        const previous = session;
        session = candidate;
        // The session row is metadata the fold carries, refreshed on every
        // lifecycle check: compare only the fields that travel on the wire,
        // and push a fresh copy to the projector (and the poll module, for
        // total_laps/meeting_name) the moment any of them changes, rather
        // than waiting for a restart to re-pick the row.
        const changed =
          candidate.status !== previous.status ||
          candidate.totalLaps !== previous.totalLaps ||
          candidate.meetingName !== previous.meetingName ||
          candidate.circuitShortName !== previous.circuitShortName ||
          candidate.location !== previous.location ||
          candidate.dateStart.getTime() !== previous.dateStart.getTime() ||
          candidate.dateEnd.getTime() !== previous.dateEnd.getTime();
        if (changed) {
          projector?.updateSession(candidate);
          try {
            opts.polls.updateSession({ totalLaps: candidate.totalLaps, meetingName: candidate.meetingName });
          } catch (err) {
            logPollHookFailure("updateSession", err);
          }
        }
        if (candidate.status === "finished") {
          await notifyFinished();
        }
        return;
      }

      // Retire the outgoing session's polls before the new one loads.
      projector?.stop();
      projector = null;
      if (session !== null) {
        await notifyFinished();
      }

      try {
        await opts.polls.start({
          sessionKey: candidate.sessionKey,
          totalLaps: candidate.totalLaps,
          country: candidate.country,
          meetingName: candidate.meetingName,
        });
      } catch (err) {
        logPollHookFailure("start", err);
      }

      session = candidate;
      finishedNotified = false;
      // A session that is already finished when first seen (restart after
      // the race, or pickSession's most-recent fallback) still had its
      // open/locked polls reloaded by start(); void them now, before the
      // projector's first push, or they stay votable forever.
      if (candidate.status === "finished") {
        await notifyFinished();
      }
      projector = new RaceStateProjector({ source: opts.source, session: candidate, log: opts.log });
      wireProjector(projector, candidate);
  }

  return {
    async check(): Promise<void> {
      if (checking) return;
      checking = true;
      try {
        await runCheck();
      } finally {
        checking = false;
      }
    },

    health(): HealthResponse {
      if (projector === null) {
        return { ok: true, session_key: null, cursor: "0", caught_up: false, viewers: opts.pusher.size() };
      }
      const status = projector.status();
      return {
        ok: true,
        session_key: status.sessionKey.toString(),
        cursor: status.cursor.toString(),
        caught_up: status.caughtUp,
        viewers: opts.pusher.size(),
      };
    },

    stop(): void {
      projector?.stop();
    },
  };
}
