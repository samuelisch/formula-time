// Config from env only (issue "Config (seam contract 4; from env only)"):
// DATABASE_URL, OPENF1_LOGIN, OPENF1_PASSWORD, LIVE_SOURCE, LIVE_LOG_DIR,
// MQTT_ENABLED (issue #25 / T6). apps/ingest/AGENTS.md: "Config is read from
// the platform secret store only, never from files in the image."

export interface IngestConfig {
  databaseUrl: string | undefined;
  openf1Login: string | undefined;
  openf1Password: string | undefined;
  /** `api` (default) talks to OpenF1 live; a directory path replays a POC recording through the same queue (used by tests). */
  liveSource: string;
  /** Where the jsonl recording is written. Default `./live-logs`, gitignored. */
  liveLogDir: string;
  /**
   * The MQTT lane (issue #25): default `true` when `OPENF1_LOGIN` is set,
   * else `false` — the free tier has no MQTT (apps/ingest/AGENTS.md; POC
   * `CLAUDE.md`). `MQTT_ENABLED=true`/`false` overrides the default either way.
   */
  mqttEnabled: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const mqttEnabledRaw = env["MQTT_ENABLED"];
  const mqttEnabled = mqttEnabledRaw !== undefined ? mqttEnabledRaw === "true" : Boolean(env["OPENF1_LOGIN"]);
  return {
    databaseUrl: env["DATABASE_URL"],
    openf1Login: env["OPENF1_LOGIN"],
    openf1Password: env["OPENF1_PASSWORD"],
    liveSource: env["LIVE_SOURCE"] ?? "api",
    liveLogDir: env["LIVE_LOG_DIR"] ?? "./live-logs",
    mqttEnabled,
  };
}
