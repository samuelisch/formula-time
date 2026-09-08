// Owns the mutable session/projector state for main.ts so the HTTP server
// can listen (and answer /health) before a session has ever been found --
// Railway's healthcheck is /health (.railway/railway.ts), and it must
// succeed on a fresh, session-less database rather than wait behind the
// pickSession retry loop. `pickSession` is injected so `check()` and
// `health()` are unit-testable with a fake that returns null, without a
// real Postgres or projector.
import type { PrismaClient, Session } from "@formula-time/db";

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

export interface SessionLifecycleOptions {
  db: PrismaClient;
  source: EventSource;
  pusher: Pusher;
  pickSession: (db: PrismaClient) => Promise<Session | null>;
  publicPolls: () => unknown[];
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

  function wireProjector(p: RaceStateProjector, forSession: Session): void {
    p.subscribe((state, cursor) => {
      void opts.pusher.push({
        type: "state",
        seq: cursor.toString(),
        sent_at: Date.now(),
        session_key: forSession.sessionKey.toString(),
        total_laps: forSession.totalLaps,
        state,
        polls: opts.publicPolls(),
      });
    });
    p.start();
  }

  return {
    async check(): Promise<void> {
      const candidate = await opts.pickSession(opts.db);
      if (candidate === null) {
        if (!warnedNoSession) {
          opts.log("no session found (upcoming, live, or finished) -- waiting");
          warnedNoSession = true;
        }
        return;
      }
      if (candidate.sessionKey === session?.sessionKey) {
        return;
      }
      projector?.stop();
      session = candidate;
      projector = new RaceStateProjector({ source: opts.source, session: candidate, log: opts.log });
      wireProjector(projector, candidate);
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
