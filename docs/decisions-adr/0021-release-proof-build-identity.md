# ADR-0021 — Release proof: build identity in /health and the web bundle

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-11
- **Owner:** Samuel Chan
- **Amends:** ADR-0019 (Decision: release.yml's smoke job content)

## Context

The first release (push of `adfe1de` to `release` on 2026-09-11 03:43 UTC)
ran `release.yml` green while both Railway services and the Netlify site
kept serving the 2026-09-10 builds. Measured 2026-09-11 04:10 UTC: the
served web bundle predated the change it should have carried, and the api
was reachable but still the old process. `release.yml`'s smoke job had no
notion of which build it was checking, so an old build answering healthy
passed as a valid release (issue #212).

## Decision

- The api's `/health` gains `"build": "<git sha>"`, read as
  `process.env.GIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "unknown"`
  -- `GIT_SHA` is an explicit override for local runs and tests; Railway's
  own runtime variable is what production reports, confirmed present in
  both `api` and `ingest` containers by measurement (see Consequences).
  The web bundle embeds the same via `VITE_GIT_SHA` (from Netlify's
  `COMMIT_REF` -- https://docs.netlify.com/build/configure-builds/environment-variables/)
  as `<meta name="build">` in `index.html`.
- `release.yml`'s `smoke` job's existing two steps now wait until the api
  reports `build` equal to `$GITHUB_SHA` (two consecutive reads) and the
  site's build meta equals `$GITHUB_SHA`, instead of only checking
  liveness. A release whose services never pick up the new SHA is red.

## Consequences

- A release that deploys nothing now fails loud instead of passing green.
- Netlify's build command (a dashboard setting per ADR-0019, not repo
  config) must set `VITE_GIT_SHA=$COMMIT_REF`; until the owner makes that
  change, the site's smoke check fails correctly rather than silently
  passing on a bundle with no build identity.
- `.claude/skills/release/SKILL.md`'s manual verification step now checks
  build identity, not just that the endpoints answer.
- Measured on the live services (`railway ssh -s api -- env` / `-s
  ingest -- env`, 2026-09-11): `RAILWAY_GIT_COMMIT_SHA`,
  `RAILWAY_GIT_BRANCH`, and the other `RAILWAY_GIT_*` variables are
  present at runtime in both containers with no build-time plumbing
  needed -- this is why `/health` reads `RAILWAY_GIT_COMMIT_SHA` directly
  instead of routing it through a Dockerfile `ARG`/`ENV` (reverted from
  an earlier version of this PR).
- The api's latest build log reads "load build definition from
  Dockerfile": with `build.builder` unset in `.railway/railway.ts`,
  Railway auto-detects the root `Dockerfile`. ADR-0019's sentence ("no
  `build.builder` here... declaring \"DOCKERFILE\" was drift, never
  actually applied") means the builder is not *declared* in the IaC
  file, not that Railway isn't using the Dockerfile -- quoted here as a
  measured fact; this PR does not amend or edit ADR-0019's text itself.

ADRs affected: 0019 (Decision: release.yml's smoke job content).
