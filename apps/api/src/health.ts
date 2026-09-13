// Wraps the session lifecycle's health with the running build's identity
// and the database's reachability, kept separate from session-lifecycle.ts
// so its own HealthResponse shape and tests stay untouched.
import type { HealthResponse } from "./session-lifecycle.js";

export type DbStatus = "ok" | "unreachable";

export interface HealthWithBuild extends HealthResponse {
  build: string;
  db: DbStatus;
}

export function resolveBuild(
  env: Partial<Pick<NodeJS.ProcessEnv, "GIT_SHA" | "RAILWAY_GIT_COMMIT_SHA">> = process.env,
): string {
  return env.GIT_SHA ?? env.RAILWAY_GIT_COMMIT_SHA ?? "unknown";
}

export function healthWithBuild(
  health: HealthResponse,
  db: DbStatus,
  env: Partial<Pick<NodeJS.ProcessEnv, "GIT_SHA" | "RAILWAY_GIT_COMMIT_SHA">> = process.env,
): HealthWithBuild {
  return { ...health, build: resolveBuild(env), db };
}

export interface DbProbeLog {
  (msg: string, fields?: Record<string, unknown>): void;
}

export interface DbProbeOptions {
  /** One `SELECT 1` round trip; rejection means "unreachable". */
  probe: () => Promise<unknown>;
  /** How often the probe re-runs; defaults to 30 s. */
  intervalMs?: number;
  log?: DbProbeLog;
}

export interface DbProbe {
  /** The last probe's outcome. `ok` optimistically, until the first probe
   * settles -- `/health` must answer before a fresh, session-less database
   * has had time for even one round trip (Railway's healthcheck fires
   * right after listen). */
  status(): DbStatus;
  /** Runs the probe once immediately, then every `intervalMs`. Never per
   * request -- `/health` only ever reads the cached `status()`. */
  start(): void;
  stop(): void;
}

const DEFAULT_PROBE_INTERVAL_MS = 30_000;

export function createDbProbe(opts: DbProbeOptions): DbProbe {
  let status: DbStatus = "ok";
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runProbe(): Promise<void> {
    try {
      await opts.probe();
      status = "ok";
    } catch (err) {
      status = "unreachable";
      opts.log?.("db probe failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    status(): DbStatus {
      return status;
    },
    start(): void {
      if (timer !== null) return;
      void runProbe();
      timer = setInterval(() => void runProbe(), opts.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
