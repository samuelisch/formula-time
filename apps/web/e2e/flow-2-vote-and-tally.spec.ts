// ADR-0002's second e2e flow: "a vote lands and the tally updates". Polls
// open as soon as the projector sees drivers and a known lap count
// (PollModule.applyState, apps/api/src/polls/poll-module.ts), which the
// drip simulator reaches within its first few pushes -- but a session
// with no open poll yet is a real possibility, so this skips rather than
// fails when one hasn't appeared.
import { expect, test, type Locator } from "@playwright/test";

import { RECORDING_PRESENT } from "./fixtures.js";

/** The rendered vote count ("N vote"/"N votes") on an option row. */
async function voteCountOf(row: Locator): Promise<number> {
  const text = await row.getByText(/^\d+ votes?$/).textContent();
  return Number(text?.match(/\d+/)?.[0] ?? "0");
}

/** Expands `poll`'s Collapsible if it is not already open. Open polls
 * default open (PollCard.tsx), but this does not assume that stays true. */
async function expandPoll(poll: Locator): Promise<void> {
  const trigger = poll.getByRole("button").first();
  if ((await trigger.getAttribute("aria-expanded")) === "false") {
    await trigger.click();
  }
}

test("a vote lands and the tally updates", async ({ page }) => {
  test.skip(!RECORDING_PRESENT, "recordings/11361 fixture not present");

  await page.goto("/polls");

  const openPoll = page.locator('article[data-status="open"]').first();
  const appeared = await openPoll
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!appeared, "no open poll opened within the wait window");

  await expandPoll(openPoll);

  // Option rows render a percentage; the Collapsible's own trigger button
  // (the summary line) does not, so this excludes it without a testid.
  const option = openPoll.getByRole("button").filter({ hasText: "%" }).first();
  const before = await voteCountOf(option);

  await option.click();

  await expect(option).toContainText("your pick");
  await expect.poll(() => voteCountOf(option)).toBe(before + 1);

  await page.reload();

  const openPollAfterReload = page.locator('article[data-status="open"]').first();
  await expect(openPollAfterReload).toBeVisible({ timeout: 30_000 });
  await expandPoll(openPollAfterReload);
  const optionAfterReload = openPollAfterReload.getByRole("button").filter({ hasText: "%" }).first();
  await expect(optionAfterReload).toContainText("your pick");
});
