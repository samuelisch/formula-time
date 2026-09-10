// ADR-0002's third e2e flow: "the delay nudge changes what is shown".
// `data-testid="source-clock"` (board/Board.tsx) and
// `data-testid="position-label"` (transport/TransportBar.tsx) are the two
// stable hooks this flow needs; neither had one before this spec.
import { expect, test, type Page } from "@playwright/test";

import { RECORDING_PRESENT } from "./fixtures.js";

/** Seconds since midnight UTC from the board's "HH:MM:SS UTC" clock text. */
function clockSeconds(text: string): number {
  const match = text.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (match === null) throw new Error(`unexpected clock text: ${text}`);
  const [, hh, mm, ss] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

/** The board's poll pop-up (PollModal.tsx) auto-opens the first time this
 * tab sees a poll newly open, which race for /live's first few seconds --
 * exactly when this flow also runs. Its backdrop covers the transport bar,
 * so a transport click dismisses it first if it is showing. */
async function dismissPollPopupIfOpen(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Race polls" });
  if (await dialog.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
}

test("the delay nudge changes what is shown", async ({ page }) => {
  test.skip(!RECORDING_PRESENT, "recordings/11361 fixture not present");

  await page.goto("/live");

  const sourceClock = page.getByTestId("source-clock");
  const positionLabel = page.getByTestId("position-label");

  await expect(sourceClock).toHaveText(/\d{2}:\d{2}:\d{2} UTC/, { timeout: 30_000 });
  const beforeSeconds = clockSeconds((await sourceClock.textContent()) ?? "");

  await dismissPollPopupIfOpen(page);
  await page.getByRole("button", { name: "−10s" }).click();

  await expect
    .poll(async () => {
      const text = await sourceClock.textContent();
      return text === null ? null : beforeSeconds - clockSeconds(text);
    })
    .toBeGreaterThanOrEqual(9);

  // Either wording is a valid delay reading: plain "N.Ns" while the nudged
  // target is still inside the live push ring buffer, "Rewound N.Ns · from
  // the log" once it falls outside and the timeline fold has taken over
  // (TransportBar.tsx's rewindMode() branch) -- which one appears depends
  // on how far the buffer had grown by the time this clicked −10s, not on
  // anything this flow is testing.
  await expect(positionLabel).toHaveText(/^(?:Rewound )?\d+\.\d+s(?: · from the log)?$/);
  const positionText = (await positionLabel.textContent()) ?? "";
  const delayMatch = positionText.match(/(\d+\.\d+)s/);
  const delaySeconds = delayMatch === null ? 0 : Number.parseFloat(delayMatch[1]);
  expect(delaySeconds).toBeGreaterThanOrEqual(9);
  expect(delaySeconds).toBeLessThanOrEqual(11);

  await dismissPollPopupIfOpen(page);
  await page.getByRole("button", { name: "Live" }).click();
  await expect(positionLabel).toHaveText("0.0s");
});
