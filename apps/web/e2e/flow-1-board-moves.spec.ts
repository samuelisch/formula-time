// ADR-0002's first e2e flow: "the board moves". Against the drip
// simulator (20x speed) a live push arrives at least every few seconds, so
// the lap counter reaching a lap and some driver's Gap cell changing are
// both short waits, not a full lap.
import { expect, test, type Page } from "@playwright/test";

import { RECORDING_PRESENT } from "./fixtures.js";

/** The Gap column's cells, in row (driver order) order, read by the "Gap"
 * header's position rather than any class name -- row 0 is P1. */
async function gapColumnValues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll("table thead th"));
    const gapIndex = headers.findIndex((th) => th.textContent?.trim() === "Gap");
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    return rows.map((row) => row.children[gapIndex]?.textContent?.trim() ?? "");
  });
}

test("the board moves", async ({ page }) => {
  test.skip(!RECORDING_PRESENT, "recordings/11361 fixture not present");

  await page.goto("/live");

  await expect(page.getByText(/^LAP \d/)).toBeVisible({ timeout: 30_000 });

  const before = await gapColumnValues(page);
  expect(before.length).toBeGreaterThan(0);

  await expect
    .poll(() => gapColumnValues(page), { timeout: 30_000, intervals: [1_000] })
    .not.toEqual(before);
});
