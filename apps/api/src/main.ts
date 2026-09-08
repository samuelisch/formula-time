// API service — the "app service" of ADR-0001: projector (the authority), poll module,
// serialize-once SSE fan-out, route handler, exporter — one process (ADR-0001 §1).
import Fastify from "fastify";

import { createDb, type Session } from "@formula-time/db";

import { Fanout } from "./fanout/fanout.js";
import { prismaEventSource } from "./projector/event-source.js";
import { pickSession } from "./projector/session-picker.js";
import { RaceStateProjector } from "./projector/projector.js";
import { registerLiveRoute } from "./routes/live.js";

const port = Number(process.env.PORT ?? 3000);
const app = Fastify({ logger: true });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const db = createDb();
const source = prismaEventSource(db);

const log = (msg: string, fields?: Record<string, unknown>): void => {
  app.log.info(fields ?? {}, msg);
};

// The poll module lands with #24; until then every push carries an empty
// poll list through the same shape the wired-in module will produce.
const pollSource = { publicPolls: (): unknown[] => [] };

const fanout = new Fanout({ log });
fanout.heartbeat();

let session: Session | null = await pickSession(db);
if (session === null) {
  app.log.warn("no session found (upcoming, live, or finished) -- waiting");
  while (session === null) {
    await sleep(5000);
    session = await pickSession(db);
  }
}

let projector = new RaceStateProjector({ source, session, log });

function wireProjector(p: RaceStateProjector, forSession: Session): void {
  p.subscribe((state, cursor) => {
    void fanout.push({
      type: "state",
      seq: cursor.toString(),
      sent_at: Date.now(),
      session_key: forSession.sessionKey.toString(),
      total_laps: forSession.totalLaps,
      state,
      polls: pollSource.publicPolls(),
    });
  });
  p.start();
}

wireProjector(projector, session);

app.get("/health", async () => {
  const status = projector.status();
  return {
    ok: true,
    session_key: status.sessionKey.toString(),
    cursor: status.cursor.toString(),
    caught_up: status.caughtUp,
    viewers: fanout.size(),
  };
});

registerLiveRoute(app, fanout);

// Every 5s, re-run pickSession; a changed key (a new session went live, or
// the next race was discovered) stops the old projector and starts a fresh
// fold from cursor 0 -- restart's rule applies here too (HLD §7 "Cursor").
const sessionWatcher = setInterval(() => {
  void (async () => {
    const candidate = await pickSession(db);
    if (candidate !== null && candidate.sessionKey !== session?.sessionKey) {
      projector.stop();
      session = candidate;
      projector = new RaceStateProjector({ source, session, log });
      wireProjector(projector, session);
    }
  })();
}, 5000);
sessionWatcher.unref?.();

process.on("SIGTERM", () => {
  clearInterval(sessionWatcher);
  projector.stop();
  fanout.stopHeartbeat();
  void db.$disconnect().then(() => process.exit(0));
});

await app.listen({ port, host: "0.0.0.0" });
