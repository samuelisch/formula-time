import { describe, expect, test } from "vitest";

import { ENTRY_LIST_SEASON } from "./entry-list.js";

describe("ENTRY_LIST_SEASON", () => {
  test("the static fallback roster has not expired", () => {
    expect(new Date().getUTCFullYear()).toBeLessThanOrEqual(ENTRY_LIST_SEASON);
    // Failing here means the static list needs updating or removing:
    // it is a hardcoded ENTRY_LIST_2026 snapshot, not a live feed, and a
    // new season's driver lineup has moved on without it.
  });
});
