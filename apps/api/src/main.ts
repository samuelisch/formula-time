// API service — the "app service" of ADR-0001: projector (the authority), poll module,
// serialize-once SSE fan-out, route handler, exporter — one process (ADR-0001 §1).
import Fastify from "fastify";

import { createDb } from "@formula-time/db";

import { Fanout } from "./fanout/fanout.js";
import { prismaEventSource } from "./projector/event-source.js";
import { pickSession } from "./projector/session-picker.js";
import { liveRoutes } from "./routes/live.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

const port = Number(process.env.PORT ?? 3000);
const app = Fastify({ logger: true });

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

const lifecycle = createSessionLifecycle({
  db,
  source,
  pusher: fanout,
  pickSession,
  publicPolls: pollSource.publicPolls,
  log,
});

// /health stays at the root: it is the platform's probe (Railway
// healthcheck, .railway/railway.ts), not a client route.
app.get("/health", async () => lifecycle.health());

// Every client-facing route lives under /api (owner decision) -- the
// public path is /api/live/events.
await app.register(liveRoutes, { prefix: "/api", fanout });

let sessionWatcher: ReturnType<typeof setInterval> | null = null;

process.on("SIGTERM", () => {
  if (sessionWatcher !== null) {
    clearInterval(sessionWatcher);
  }
  lifecycle.stop();
  fanout.stopHeartbeat();
  void db.$disconnect().then(() => process.exit(0));
});

// Listen first: Railway's healthcheck is /health (.railway/railway.ts), and
// it must succeed on a fresh, session-less database rather than block
// behind session discovery. /api/live/events also joins normally with no
// session yet -- the fan-out has no `latest`, so the socket gets the
// `catching_up` status frame the brief already specifies.
await app.listen({ port, host: "0.0.0.0" });

// Run pickSession now and every 5s after; a changed key (first discovery,
// a new race gone live, or the next race appearing) stops the old
// projector and starts a fresh fold from cursor 0 -- restart's rule
// applies here too (HLD §7 "Cursor").
void lifecycle.check();
sessionWatcher = setInterval(() => {
  void lifecycle.check();
}, 5000);
sessionWatcher.unref?.();
