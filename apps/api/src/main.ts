// API service — the "app service" of ADR-0001: projector (the authority), poll module,
// serialize-once SSE fan-out, route handler, exporter — one process (ADR-0001 §1).
import Fastify from "fastify";

import { createDb } from "@formula-time/db";

import { parseAllowedOrigins, registerCors } from "./cors.js";
import { createExporter } from "./export/exporter.js";
import { Fanout } from "./fanout/fanout.js";
import { PollModule } from "./polls/poll-module.js";
import { registerPolls } from "./polls/routes.js";
import { prismaEventSource } from "./projector/event-source.js";
import { pickSession } from "./projector/session-picker.js";
import { liveRoutes } from "./routes/live.js";
import { racesRoutes } from "./routes/races.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

const port = Number(process.env.PORT ?? 3000);
const app = Fastify({ logger: true });

// The web bundle is hosted on its own origin (ADR-0008); allow it here,
// before any route, so the preflight and the hijacked SSE route see it.
await registerCors(app, parseAllowedOrigins(process.env.CORS_ORIGIN));

const db = createDb();
const source = prismaEventSource(db);

const log = (msg: string, fields?: Record<string, unknown>): void => {
  app.log.info(fields ?? {}, msg);
};

const pollModule = new PollModule({ db, log: { info: (msg) => app.log.info(msg) } });

const fanout = new Fanout({ log });
fanout.heartbeat();

// ADR-0009 §2: "EXPORT_DIR joins the seam-4 config names," default
// `./exports`. Own 5s tick (started after listen, below); independent of
// the session lifecycle.
const exportDir = process.env.EXPORT_DIR ?? "./exports";
const exporter = createExporter({ db, dir: exportDir, log });

const lifecycle = createSessionLifecycle({
  db,
  source,
  pusher: fanout,
  pickSession,
  polls: pollModule,
  log,
});

// /health stays at the root: it is the platform's probe (Railway
// healthcheck, .railway/railway.ts), not a client route.
app.get("/health", async () => lifecycle.health());

// Every client-facing route lives under /api (owner decision) -- the
// public path is /api/live/events.
await app.register(liveRoutes, { prefix: "/api", fanout });
await app.register(registerPolls(pollModule), { prefix: "/api" });

// ADR-0009 §4: the two historical-race routes, /api/races and
// /api/races/:session_key -- "Serving reads the file, not Postgres."
await app.register(racesRoutes, { prefix: "/api", db, exporter, dir: exportDir });

let sessionWatcher: ReturnType<typeof setInterval> | null = null;

process.on("SIGTERM", () => {
  if (sessionWatcher !== null) {
    clearInterval(sessionWatcher);
  }
  lifecycle.stop();
  fanout.stopHeartbeat();
  exporter.stop();
  void db.$disconnect().then(() => process.exit(0));
});

// Listen first: Railway's healthcheck is /health (.railway/railway.ts), and
// it must succeed on a fresh, session-less database rather than block
// behind session discovery. /api/live/events also joins normally with no
// session yet -- the fan-out has no `latest`, so the socket gets the
// `catching_up` status frame the brief already specifies.
await app.listen({ port, host: "0.0.0.0" });

// The exporter owns its own 5s tick (issue #44) -- it does not touch
// session-lifecycle.ts, which two other PRs are editing.
exporter.start();

// Run pickSession now and every 5s after; a changed key (first discovery,
// a new race gone live, or the next race appearing) stops the old
// projector and starts a fresh fold from cursor 0 -- restart's rule
// applies here too (HLD §7 "Cursor").
void lifecycle.check();
sessionWatcher = setInterval(() => {
  void lifecycle.check();
}, 5000);
sessionWatcher.unref?.();
