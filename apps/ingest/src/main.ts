// Ingest service: the ONLY process that talks to OpenF1 (ADR-0001 §1).
// Wires auth -> rest lane -> queue -> writer (issue deliverable 5). MQTT lane
// is T6, not here (apps/ingest/AGENTS.md: "Two lanes always on" is the target
// shape; this task builds the REST lane, the safety net, first).

import { createDb } from "@formula-time/db";

import { credentialsFromEnv, createOpenF1Fetcher, OpenF1Auth } from "./openf1/auth.js";
import { loadConfig } from "./config.js";
import { createFileFetcher } from "./openf1/file-fetcher.js";
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

const db = createDb(config.databaseUrl, { max: 1 });
const queue = new EventQueue<QueueItem>();
const writer = new EventWriter(db, queue);
const recorder = new JsonlRecorder(config.liveLogDir);

let fetcher: Fetcher;
if (config.liveSource === "api") {
  const creds = credentialsFromEnv();
  if (!creds) {
    console.log(
      "ingest: OPENF1_LOGIN/OPENF1_PASSWORD not set; running unauthenticated (historical use only, live will 401).",
    );
  }
  const auth = new OpenF1Auth(creds);
  fetcher = createOpenF1Fetcher(auth);
} else {
  console.log(`ingest: LIVE_SOURCE=${config.liveSource} — replaying a recording instead of OpenF1.`);
  fetcher = createFileFetcher(config.liveSource);
}

function sessionKeyOf(session: RawRecord): string | number | null {
  const value = session["session_key"];
  return typeof value === "number" || typeof value === "string" ? value : null;
}

const restLane = new RestLane(queue, {
  fetcher,
  onSession: async (session, nowMs) => {
    await upsertSession(db, session, nowMs);
    const key = sessionKeyOf(session);
    if (key !== null) await recorder.writeSession(session, key);
  },
  onNewRows: async (sessionKey, endpoint, rows) => {
    await recorder.appendRows(sessionKey, endpoint, rows);
  },
  onLog: (line) => console.log(line),
});

restLane.start();
writer.run();
console.log("ingest: started (REST lane + writer running; discovering a session)");

let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("ingest: SIGTERM received, draining queue");
  restLane.stop();
  void writer
    .stop()
    .then((totals) => {
      console.log(`ingest: drained (inserted=${totals.inserted} skipped=${totals.skipped}); exiting`);
      return db.$disconnect();
    })
    .catch((error: unknown) => {
      console.error(`ingest: error while draining: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      process.exit(0);
    });
});
