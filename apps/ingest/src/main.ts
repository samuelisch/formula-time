// Ingest service: the ONLY process that talks to OpenF1 (ADR-0001 §1).
// Wires auth -> rest lane -> queue -> writer, and the MQTT lane onto the
// same queue — both lanes always run, no failover between them.

import { createDb } from "@formula-time/db";

import { credentialsFromEnv, createOpenF1Fetcher, OpenF1Auth } from "./openf1/auth.js";
import { loadConfig } from "./config.js";
import { countFields, logger } from "./log.js";
import type { LaneLog } from "./log.js";
import { createFileFetcher } from "./openf1/file-fetcher.js";
import { ENTRY_LIST_SEASON } from "./openf1/entry-list.js";
import { MqttLane } from "./openf1/mqtt-lane.js";
import { JsonlRecorder } from "./openf1/recorder.js";
import { checkRecordingRoot, realRecordingRootFs } from "./openf1/recording-root.js";
import { RestLane } from "./openf1/rest-lane.js";
import type { Fetcher, QueueItem, RawRecord } from "./openf1/types.js";
import { EventQueue } from "./writer/queue.js";
import { upsertSession } from "./writer/sessions.js";
import { EventWriter } from "./writer/writer.js";

// Registered before anything else starts: neither this service nor the api
// caught these before, so a crash printed a bare stack trace with no
// service, build or lane field -- a log query for an error finds nothing
// and the "ingest: last 60s" line just stops. Exit semantics are
// unchanged (the platform restarts the service); only the evidence is new.
function fatal(kind: string, reason: unknown): void {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ kind, reason: { message: err.message, stack: err.stack ?? null } }, "ingest: fatal error");
  process.nextTick(() => process.exit(1));
}

process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
process.on("uncaughtException", (err) => fatal("uncaughtException", err));

const config = loadConfig();

if (!config.databaseUrl) {
  logger.error("ingest: DATABASE_URL is not set; refusing to start (ADR-0004 config seam).");
  process.exit(1);
}

if (config.restTickMsInvalid !== undefined) {
  logger.info(
    `ingest: REST_TICK_MS=${config.restTickMsInvalid} is invalid; using the tier default ${config.restTickMs}ms (ADR-0030).`,
  );
}

logger.info(`entry list: static fallback is for ${ENTRY_LIST_SEASON}`);

// Every lane's and the writer's log(message, opts?) callback funnels
// through here, so a log query can filter by lane, by level, and by the
// counts a message reports without parsing `msg` (apps/ingest/src/log.ts).
function laneLog(lane: "rest" | "mqtt" | "writer"): LaneLog {
  return (message, opts): void => {
    const level = opts?.level ?? "info";
    logger[level]({ lane, ...opts?.fields, ...countFields(message) }, message);
  };
}

const db = createDb(config.databaseUrl, { max: 1 });
const queue = new EventQueue<QueueItem>();
const writer = new EventWriter(db, queue, { log: laneLog("writer") });
const recorder = new JsonlRecorder(config.liveLogDir);

let fetcher: Fetcher;
// Set only on the `api` path — the MQTT lane needs the SAME auth instance
// the REST lane's fetcher uses, and the login as its MQTT username.
let mqttAuth: OpenF1Auth | null = null;
let openf1Login: string | null = null;
if (config.liveSource === "api") {
  const creds = credentialsFromEnv();
  if (!creds) {
    logger.info(
      "ingest: OPENF1_LOGIN/OPENF1_PASSWORD not set; running unauthenticated (historical use only, live will 401).",
    );
  }
  const auth = new OpenF1Auth(creds, { log: laneLog("rest") });
  fetcher = createOpenF1Fetcher(auth);
  mqttAuth = auth;
  openf1Login = creds?.login ?? null;
} else {
  logger.info(`ingest: LIVE_SOURCE=${config.liveSource} — replaying a recording instead of OpenF1.`);
  fetcher = createFileFetcher(config.liveSource);
}

function sessionKeyOf(session: RawRecord): string | number | null {
  const value = session["session_key"];
  return typeof value === "number" || typeof value === "string" ? value : null;
}

// The one recorder wiring both lanes share: `enqueueRows` (openf1/enqueue.ts)
// calls this with exactly the rows it just queued, whichever lane queued
// them, so the jsonl recording holds every row the session produced (not
// just the REST lane's) — the shared normalizer's `seen` set is why a
// per-lane recorder call would silently miss a row the other lane saw
// first.
const recordRows = async (sessionKey: number, endpoint: string, payloads: RawRecord[]): Promise<void> => {
  await recorder.appendRows(sessionKey, endpoint, payloads);
};

const restLane = new RestLane(queue, {
  fetcher,
  // Every session row discovery sees, every discovery tick: upsert only.
  // The jsonl recorder's session.json write does NOT belong here — see
  // onSessionSelected below.
  onSession: async (session, nowMs, meetingNames) => {
    await upsertSession(db, session, nowMs, { meetingNames });
  },
  // Once per newly-selected session, not once per discovery tick:
  // recorder.writeSession() living in onSession instead re-creates/
  // truncates the directory and session.json, and re-stamps discovered_at,
  // for every session of the year, every 60s while nothing is live.
  onSessionSelected: async (session) => {
    const key = sessionKeyOf(session);
    if (key !== null) await recorder.writeSession(session, key);
  },
  onRecorded: recordRows,
  liveLogDir: config.liveLogDir,
  tickMs: config.restTickMs,
  onLog: laneLog("rest"),
});

// The MQTT lane: only against the real OpenF1 broker
// (`LIVE_SOURCE=api` — a file replay has no broker to connect to), only with
// credentials to authenticate as (mqttAuth/openf1Login are set together on
// the `api` path above), and only when MQTT_ENABLED says so (default `true`
// when OPENF1_LOGIN is set, else `false` — the free tier has no MQTT).
const mqttLane =
  config.mqttEnabled && mqttAuth && openf1Login
    ? new MqttLane(queue, {
        auth: mqttAuth,
        username: openf1Login,
        // the shared LiveNormalizer with the CURRENT session key from the
        // REST lane's selection — REST is the authority on which session is
        // live.
        getNormalizer: () => restLane.getNormalizer(),
        getSessionKey: () => restLane.status().sessionKey,
        onRecorded: recordRows,
        onLog: laneLog("mqtt"),
      })
    : null;
if (config.mqttEnabled && !mqttLane) {
  logger.info("ingest: MQTT_ENABLED but no OpenF1 credentials/live source; MQTT lane not started.");
}

// The recording root probe reports, at boot, whether the jsonl recording
// (the irreplaceable artefact, ADR-0034) will actually land — before the
// lanes start, so a broken volume is visible from the first minute of a
// race rather than discovered after it. Never exits and never throws out
// of here: a disk problem must not take the live capture down.
async function logRecordingRoot(): Promise<void> {
  const uid = process.getuid?.() ?? -1;
  try {
    const result = await checkRecordingRoot({
      dir: config.liveLogDir,
      liveLogDirExplicit: config.liveLogDirExplicit,
      fs: realRecordingRootFs,
    });
    if (result.ok) {
      logger.info(`ingest: recording root ${config.liveLogDir} is writable (uid=${uid})`);
    } else if (result.reason === "not-writable") {
      logger.error(
        `ingest: recording root ${config.liveLogDir} is NOT writable (uid=${uid}): ${result.message} — recordings will not be written`,
      );
    } else {
      logger.error(
        `ingest: recording root ${config.liveLogDir} is on the container's root filesystem, not a mounted volume — recordings will not survive a redeploy`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `ingest: recording root ${config.liveLogDir} is NOT writable (uid=${uid}): ${message} — recordings will not be written`,
    );
  }
}

await logRecordingRoot();

restLane.start();
mqttLane?.start();
writer.run();
logger.info(
  `ingest: started (REST lane tick=${config.restTickMs}ms${mqttLane ? " + MQTT lane" : ""} + writer running; discovering a session)`,
);

// One line per minute across both lanes and the writer: each takeStats()
// resets its own counters, so a query never double-counts across two
// lines. `build` is not added here: pino's base fields (service, build)
// already land on every line, this one included.
const STATS_INTERVAL_MS = 60_000;
const statsInterval = setInterval(() => {
  const rest = restLane.takeStats();
  const mqtt = mqttLane?.takeStats() ?? { messages: 0, rows: 0, dropped: 0, unjoined: 0, foreign: 0 };
  const writerStats = writer.takeStats();
  logger.info(
    {
      rest_polls: rest.polls,
      rest_rows: rest.rows,
      rest_errors: rest.errors,
      rest_unjoined: rest.unjoined,
      mqtt_messages: mqtt.messages,
      mqtt_rows: mqtt.rows,
      mqtt_dropped: mqtt.dropped,
      mqtt_unjoined: mqtt.unjoined,
      mqtt_foreign: mqtt.foreign,
      writer_inserted: writerStats.inserted,
      writer_skipped: writerStats.skipped,
      writer_failures: writerStats.failures,
      queue_depth: queue.size,
      session_key: restLane.status().sessionKey,
    },
    "ingest: last 60s",
  );
}, STATS_INTERVAL_MS);

let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(statsInterval);
  logger.info("ingest: SIGTERM received, draining queue");
  // Wait for any in-flight poll to finish enqueueing (REST) and the MQTT
  // client to end before draining the writer — otherwise a lane still
  // enqueueing lands rows on the queue after the writer has already drained
  // and the process has exited (the SIGTERM race: `stop()` on either lane
  // alone only stops scheduling future work, it doesn't wait for what's
  // already in flight).
  void Promise.all([restLane.stop(), mqttLane ? mqttLane.stop() : Promise.resolve()])
    .then(() => writer.stop())
    .then((totals) => {
      const message = `ingest: drained (inserted=${totals.inserted} skipped=${totals.skipped}); exiting`;
      logger.info(countFields(message), message);
      return db.$disconnect();
    })
    .catch((error: unknown) => {
      logger.error(`ingest: error while draining: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      process.exit(0);
    });
});
