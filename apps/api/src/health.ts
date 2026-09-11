// Wraps the session lifecycle's health with the running build's identity
// (issue #212) -- kept separate from session-lifecycle.ts so its own
// HealthResponse shape and tests stay untouched.
import type { HealthResponse } from "./session-lifecycle.js";

export interface HealthWithBuild extends HealthResponse {
  build: string;
}

export function healthWithBuild(
  health: HealthResponse,
  env: Partial<Pick<NodeJS.ProcessEnv, "GIT_SHA">> = process.env,
): HealthWithBuild {
  return { ...health, build: env.GIT_SHA ?? "unknown" };
}
