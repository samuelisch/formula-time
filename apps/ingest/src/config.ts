// Config is read from env only: DATABASE_URL, OPENF1_LOGIN, OPENF1_PASSWORD,
// LIVE_SOURCE, LIVE_LOG_DIR, MQTT_ENABLED, REST_TICK_MS, LOG_LEVEL (read by
// log.ts directly, not through this module). apps/ingest/AGENTS.md: "Config
// is read from the platform secret store only, never from files in the
// image."

export interface IngestConfig {
  databaseUrl: string | undefined;
  openf1Login: string | undefined;
  openf1Password: string | undefined;
  /** `api` (default) talks to OpenF1 live; a directory path replays a POC recording through the same queue (used by tests). */
  liveSource: string;
  /** Where the jsonl recording is written. Default `./live-logs`, gitignored. */
  liveLogDir: string;
  /**
   * The MQTT lane: default `true` when `OPENF1_LOGIN` is set,
   * else `false` — the free tier has no MQTT (apps/ingest/AGENTS.md; POC
   * `CLAUDE.md`). `MQTT_ENABLED=true`/`false` overrides the default either way.
   */
  mqttEnabled: boolean;
  /**
   * REST lane rotation cadence, by tier (ADR-0030): 2200ms with no OpenF1
   * credentials (the free tier's 27 requests/minute budget), 1100ms when
   * both `OPENF1_LOGIN` and `OPENF1_PASSWORD` are set (the POC recorder's
   * sponsored cadence). `REST_TICK_MS` overrides either tier default.
   */
  restTickMs: number;
  /**
   * The raw `REST_TICK_MS` value when it was set but rejected (not a
   * positive integer) — `undefined` when unset or valid. `main.ts` logs this
   * once at startup (ADR-0030: "falls back to the tier default and logs one
   * line").
   */
  restTickMsInvalid: string | undefined;
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const mqttEnabledRaw = env["MQTT_ENABLED"];
  const mqttEnabled = mqttEnabledRaw !== undefined ? mqttEnabledRaw === "true" : Boolean(env["OPENF1_LOGIN"]);

  const sponsored = Boolean(env["OPENF1_LOGIN"] && env["OPENF1_PASSWORD"]);
  const tierDefaultTickMs = sponsored ? 1100 : 2200;
  const tickOverrideRaw = env["REST_TICK_MS"];
  const parsedTickMs = tickOverrideRaw !== undefined ? parsePositiveInt(tickOverrideRaw) : null;
  const restTickMs = parsedTickMs ?? tierDefaultTickMs;
  const restTickMsInvalid = tickOverrideRaw !== undefined && parsedTickMs === null ? tickOverrideRaw : undefined;

  return {
    databaseUrl: env["DATABASE_URL"],
    openf1Login: env["OPENF1_LOGIN"],
    openf1Password: env["OPENF1_PASSWORD"],
    liveSource: env["LIVE_SOURCE"] ?? "api",
    liveLogDir: env["LIVE_LOG_DIR"] ?? "./live-logs",
    mqttEnabled,
    restTickMs,
    restTickMsInvalid,
  };
}
