// Ingest service: the ONLY process that talks to OpenF1 (ADR-0001 §1).
// Wires auth -> rest lane -> queue -> writer, and the MQTT lane onto the
// SAME queue: "Two lanes always on, no failover logic" (apps/ingest/AGENTS.md).

import { createDb } from "@formula-time/db";

import { credentialsFromEnv, createOpenF1Fetcher, OpenF1Auth } from "./openf1/auth.js";
import { loadConfig } from "./config.js";
import { countFields, logger } from "./log.js";
import { createFileFetcher } from "./openf1/file-fetcher.js";
import { MqttLane } from "./openf1/mqtt-lane.js";
import { JsonlRecorder } from "./openf1/recorder.js";
import { RestLane } from "./openf1/rest-lane.js";
import type { Fetcher, QueueItem, RawRecord } from "./openf1/types.js";
import { EventQueue } from "./writer/queue.js";
import { upsertSession } from "./writer/sessions.js";
import { EventWriter } from "./writer/writer.js";

const config = loadConfig();

if (!config.databaseUrl) {
  console.error("ingest: DATABASE_URL is not set; refusing to start (ADR-0004 config seam).");
  process.exit(1);
}

// Every lane's and the writer's log(message) callback funnels through here,
// so a log query can filter by lane and by the counts a message reports
// without parsing `msg` (apps/ingest/src/log.ts).
function laneLog(lane: "rest" | "mqtt" | "writer"): (message: string) => void {
  return (message: string): void => {
    logger.info({ lane, ...countFields(message) }, message);
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
  const auth = new OpenF1Auth(creds);
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

const restLane = new RestLane(queue, {
  fetcher,
  // Every session row discovery sees, every discovery tick: upsert only.
  // The jsonl recorder's session.json write does NOT belong here — see
  // onSessionSelected below.
  onSession: async (session, nowMs) => {
    await upsertSession(db, session, nowMs);
  },
  // Once per newly-selected session, not once per discovery tick:
  // recorder.writeSession() living in onSession instead re-creates/
  // truncates the directory and session.json, and re-stamps discovered_at,
  // for every session of the year, every 60s while nothing is live.
  onSessionSelected: async (session) => {
    const key = sessionKeyOf(session);
    if (key !== null) await recorder.writeSession(session, key);
  },
  onNewRows: async (sessionKey, endpoint, rows) => {
    await recorder.appendRows(sessionKey, endpoint, rows);
  },
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
        onLog: laneLog("mqtt"),
      })
    : null;
if (config.mqttEnabled && !mqttLane) {
  logger.info("ingest: MQTT_ENABLED but no OpenF1 credentials/live source; MQTT lane not started.");
}

restLane.start();
mqttLane?.start();
writer.run();
logger.info(
  `ingest: started (REST lane${mqttLane ? " + MQTT lane" : ""} + writer running; discovering a session)`,
);

let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
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
      console.error(`ingest: error while draining: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      process.exit(0);
    });
});
