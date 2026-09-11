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
   for both deploys and confirms they serve traffic. It also watches
   `railway-apply.yml` on the same commit (`gh run list --workflow
   railway-apply.yml --branch release --limit 1`) — a failed apply fails
   the release. A failed smoke job is red on the commit; it does not roll
   anything back — decide by hand whether to fix forward or roll back
   (step 5).

4. Once green, confirm by hand:

   - `https://api-production-8fbf2.up.railway.app/health` — confirm
     `"build"` equals the pushed commit SHA, not just that the response is
     healthy (an old build answering healthy is not a release).
   - `https://strong-marshmallow-9d4572.netlify.app/` — confirm the page's
     `<meta name="build">` equals the same SHA.

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
