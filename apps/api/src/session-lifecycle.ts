// Owns the mutable session/projector state for main.ts so the HTTP server
// can listen (and answer /health) before a session has ever been found --
// Railway's healthcheck is /health (.railway/railway.ts), and it must
// succeed on a fresh, session-less database rather than wait behind the
// pickSession retry loop. `pickSession` is injected so `check()` and
// `health()` are unit-testable with a fake that returns null, without a
// real Postgres or projector.
import type { PrismaClient, Session } from "@formula-time/db";
import type { RaceState } from "@formula-time/domain";

import type { EventSource } from "./projector/event-source.js";
import { RaceStateProjector, type ProjectorLog } from "./projector/projector.js";

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

// The poll module's lifecycle hooks, as seen from session-lifecycle: it
// folds from the same authority state as the projector (apps/api/AGENTS.md
// "The poll module"), so start/onSessionFinished are sequenced around the
// projector here rather than left for PollModule to discover on its own.
export interface PollHooks {
  start(session: { sessionKey: bigint; totalLaps: number | null; country: string }): Promise<void>;
  /** Resolves once this state's fold has landed; the push waits for it. */
  onState(state: RaceState): Promise<void>;
  onSessionFinished(): Promise<void>;
  publicPolls(): unknown[];
}

export interface SessionLifecycleOptions {
  db: PrismaClient;
  source: EventSource;
  pusher: Pusher;
  pickSession: (db: PrismaClient) => Promise<Session | null>;
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
    p.subscribe((state, cursor, events, rebuilt) => {
      // The poll module folds from the same authority state before the one
      // serialize: a push must never carry a stale lock. onState() only
      // schedules the fold, so the push waits for it. Folds are a FIFO
      // chain and this continuation is registered before the next tick can
      // queue its own, so push N always sees exactly fold N.
      void opts.polls.onState(state).then(() => {
        // `events` is the RaceEvent rows the projector applied this tick, in
        // seq order (`[]` when none) -- a client folds them into its own
        // deep-rewind timeline rather than the api building one server-side.
        // `rebuilt` rides along only when the late-commit detector's rebuild
        // produced this push (the client must then discard its timeline and
        // backfill again), so it is omitted -- rather than sent as `false` --
        // on every ordinary tick.
        const payload: Record<string, unknown> = {
          type: "state",
          seq: cursor.toString(),
          sent_at: Date.now(),
          session_key: forSession.sessionKey.toString(),
          total_laps: forSession.totalLaps,
          state,
          polls: opts.polls.publicPolls(),
          events,
        };
        if (rebuilt) {
          payload.rebuilt = true;
        }
        return opts.pusher.push(payload);
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

      if (candidate.sessionKey === session?.sessionKey) {
        session = candidate;
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
