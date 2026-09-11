---
name: retro
description: Use at the end of a working day or when a feature closes, to record what the merged PRs since a date say went well, went wrong, and should change next time.
---

# Retro

## Overview

Every PR carries three lines: Summary, Friction, Agent. A retro is a read of those lines over a period, written down so the next period starts from it.

## Steps

1. Run `node scripts/retro.mjs <YYYY-MM-DD>` (the period start; default today). It prints one row per merged PR.
2. If it reports missing lines, note the PR numbers under "went wrong": the template was not followed.
3. Write `docs/retros/<YYYY-MM-DD>.md` with exactly these sections, each a short bulleted list citing PR numbers:
   - **Went well** — from Summary lines that landed without Friction.
   - **Went wrong** — every non-"none" Friction line, grouped by cause when two PRs share one.
   - **Try next time** — one concrete change per cause above: a rule for AGENTS.md, a fix to a skill or hook, an issue-body improvement. Name the file that changes.
4. Paste the script's table at the bottom under **Evidence**.
5. Commit the retro and open its PR in the same session, before anything else; an untracked retro is not a record.
6. Apply any "try next time" item that is a one-line change. Prose changes (AGENTS.md, a skill) may share the retro commit. Changes to hooks or `.claude/settings.json` go in their own commit, so the guardrail edit is read line by line and never rides in with the write-up. Larger items become issues.

## Common mistakes

- Writing the retro from memory instead of the PR lines. The lines are the record.
- A "try next time" with no file named. If nothing changes, the retro did nothing.
