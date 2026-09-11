import { describe, expect, test } from "vitest";

import { healthWithBuild } from "./health.js";

describe("healthWithBuild", () => {
  const health = { ok: true as const, session_key: null, cursor: "0", caught_up: false, viewers: 0 };

  test("adds the build field from GIT_SHA", () => {
    expect(healthWithBuild(health, { GIT_SHA: "abc123" })).toEqual({ ...health, build: "abc123" });
  });

  test('falls back to "unknown" when GIT_SHA is unset', () => {
    expect(healthWithBuild(health, {})).toEqual({ ...health, build: "unknown" });
  });
});
