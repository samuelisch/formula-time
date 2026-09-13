// API service — the "app service" of ADR-0001: projector (the authority), poll module,
// serialize-once SSE fan-out, route handler, exporter — one process (ADR-0001 §1).
import helmet from "@fastify/helmet";
import Fastify from "fastify";

import { createDb } from "@formula-time/db";

import { parseAllowedOrigins, registerCors } from "./cors.js";
import { createExporter } from "./export/exporter.js";
import { Fanout } from "./fanout/fanout.js";
import { createDbProbe, healthWithBuild, resolveBuild } from "./health.js";
import { PollModule } from "./polls/poll-module.js";
import { registerPolls } from "./polls/routes.js";
import { prismaEventSource } from "./projector/event-source.js";
import { pickSession } from "./projector/session-picker.js";
import { liveRoutes } from "./routes/live.js";
import { racesRoutes } from "./routes/races.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { TRUST_PROXY } from "./trust-proxy.js";

// PORT is the platform's own convention (Railway sets it); API_PORT is the
// worktree-specific dev port from scripts/db-env.sh, read only when PORT is
// absent so a deployed service (which always sets PORT) is unaffected.
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);
// trustProxy (see trust-proxy.ts): Railway terminates TLS at its own proxy
// and forwards the client address in X-Forwarded-For. Without this every
// request would share the proxy's own address, and the vote route's
// per-IP rate limit would throttle every client together instead of
// individually.
const app = Fastify({ logger: true, trustProxy: TRUST_PROXY });

// The web bundle is hosted on its own origin (ADR-0008); allow it here,
// before any route, so the preflight and the hijacked SSE route see it.
await registerCors(app, parseAllowedOrigins(process.env.CORS_ORIGIN));

// Standard security headers on every response. CSP is off: the api serves
// only JSON and an event stream, no documents to constrain. CORP is
// cross-origin so the bundle, hosted on its own origin (ADR-0008), can read
// the response. HSTS runs one year, no subdomains (this container answers
// for its own host only). Framing is denied outright: nothing legitimate
// embeds this api in a frame. Runs as an `onRequest` hook, so it decorates
// the reply before the hijacked SSE route calls `hijack()` -- the headers
// still ride along through `replyHeaders` (cors.ts).
await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: false },
  frameguard: { action: "deny" },
});

const db = createDb();
const source = prismaEventSource(db);

const log = (msg: string, fields?: Record<string, unknown>): void => {
  app.log.info(fields ?? {}, msg);
};

// /health's `db` field: a cached SELECT 1 result refreshed every 30 s, never
// per request, so the platform's healthcheck and a person can tell a dead
// database from an idle session without adding a query to every probe.
const dbProbe = createDbProbe({ probe: () => db.$queryRaw`SELECT 1`, log });

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
// healthcheck, .railway/railway.ts), not a client route. `ok` stays true
// even when `db` is "unreachable" as long as the projector holds a fold --
// a dead database degrades reads, it does not make the running process
// unhealthy.
app.get("/health", async () => healthWithBuild(lifecycle.health(), dbProbe.status()));

// Every client-facing route lives under /api (owner decision) -- the
// public path is /api/live/events.
await app.register(liveRoutes, { prefix: "/api", fanout });
await app.register(registerPolls(pollModule, db), { prefix: "/api" });

// ADR-0009 §4: the two historical-race routes, /api/races and
// /api/races/:session_key -- "Serving reads the file, not Postgres."
await app.register(racesRoutes, { prefix: "/api", db, exporter, dir: exportDir });

let sessionWatcher: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

process.on("SIGTERM", () => {
  if (sessionWatcher !== null) {
    clearInterval(sessionWatcher);
  }
  if (statsTimer !== null) {
    clearInterval(statsTimer);
  }
  dbProbe.stop();
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

// The exporter owns its own 5s tick; it does not touch session-lifecycle.ts.
exporter.start();

// Runs the first SELECT 1 immediately, then every 30 s (health.ts).
dbProbe.start();

// Run pickSession now and every 5s after; a changed key (first discovery,
// a new race gone live, or the next race appearing) stops the old
// projector and starts a fresh fold from cursor 0 -- restart's rule
// applies here too (HLD §7 "Cursor").
void lifecycle.check();
sessionWatcher = setInterval(() => {
  void lifecycle.check();
}, 5000);
sessionWatcher.unref?.();

// One structured line every 60 s, same shape and cadence as ingest's
// "mqtt: last 60s" line so one log query reads both services: gauges from
// the session lifecycle's health() plus the fan-out's own counters, which
// statsSnapshot() resets for the next window.
const build = resolveBuild(process.env);
statsTimer = setInterval(() => {
  const health = lifecycle.health();
  const stats = fanout.statsSnapshot();
  log("api: last 60s", {
    viewers: health.viewers,
    delta_viewers: stats.delta_viewers,
    pushes: stats.pushes,
    state_bytes_gz: stats.state_bytes_gz,
    delta_bytes_gz: stats.delta_bytes_gz,
    slow_drops: stats.slow_drops,
    cursor: health.cursor,
    caught_up: health.caught_up,
    session_key: health.session_key,
    build,
  });
}, 60_000);
statsTimer.unref?.();
