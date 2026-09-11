---
name: release
description: Ship a release by fast-forwarding the release branch to a CI-green main commit. Use when the owner says to release, ship, deploy, or cut a release.
---

# Release

## Overview

Railway (`api`, `ingest`) and Netlify both build only from the `release`
branch (ADR-0019). Pushing to `main` never deploys anything — `main` is
the always-green integration branch, and a release is a deliberate
fast-forward of `release` to a `main` commit that has already passed CI.

## Steps

1. Confirm the commit you want to release is CI-green:

   ```
   gh run list --branch main --limit 1
   ```

2. Release it — this is a fast-forward push, from any checkout, never a
   merge or a rebase:

   ```
   git fetch origin
   git push origin origin/main:release
   ```

3. Watch `release.yml` run on the pushed commit. It reuses `ci.yml`'s gate
   (the same checks the PR already passed), then a `smoke` job that waits
   for both deploys and confirms they serve traffic. A failed smoke job is
   red on the commit; it does not roll anything back — decide by hand
   whether to fix forward or roll back (step 5).

4. Once green, confirm by hand:

   - `https://api-production-8fbf2.up.railway.app/health` — see the
     load-race skill's `## Verify` section for the request/response shape
     this project checks a live deploy against.
   - `https://strong-marshmallow-9d4572.netlify.app/`

## Rules

- Never push anything to `release` except `origin/main` (or an earlier
  main commit, for a rollback). Never commit directly on `release`.
- `release` only ever fast-forwards. If a push is ever rejected as
  non-fast-forward, stop and ask the owner rather than force-pushing.

## Rolling back

A bad release is rolled back the same way, pointed at the last known-good
main commit instead of the current tip:

```
git push origin <good-sha>:release
```
