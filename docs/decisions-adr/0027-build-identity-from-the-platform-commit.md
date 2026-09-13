# ADR-0027 — Build identity resolves from the platform's own commit variable

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-13
- **Owner:** Samuel Chan
- **Amends:** ADR-0021 (Decision: the web bundle's `VITE_GIT_SHA` came
  from a Netlify dashboard build-command setting; Consequences: that
  setting "must" be made by hand or the release smoke check fails
  correctly rather than passing).

## Context

ADR-0021's build-identity mechanism for the web bundle depended on the
owner setting `VITE_GIT_SHA=$COMMIT_REF` in Netlify's dashboard build
command — a manual, per-platform step outside the repo. That setting was
never made: the served site kept showing the literal `%VITE_GIT_SHA%`
placeholder, and `release.yml`'s smoke job failed on the site check on
every release (measured 2026-09-13 on build `ba8b2da`, issue #254).
Number `0027` is the next free ADR number after the highest tracked on
`origin/main` (`0026-session-names-on-the-wire.md`) at the moment this
file was created; no open PR's diff touched `docs/decisions-adr/`
(`gh pr list --state open --json number,files` returned no ADR paths).

## Decision

- `apps/web/vite.config.ts` resolves the build SHA itself instead of
  relying on a dashboard-set env var: `process.env.VITE_GIT_SHA ??
  process.env.COMMIT_REF ?? process.env.GITHUB_SHA ?? "unknown"`, and a
  `transformIndexHtml` plugin substitutes it into `index.html`'s `<meta
  name="build">` tag. The literal `%VITE_GIT_SHA%` placeholder never
  ships: if every source is unset, the content is `"unknown"`.
- `VITE_GIT_SHA` stays as the explicit override for a manual build.
  `COMMIT_REF` is Netlify's own build-time variable, set on every Netlify
  build with no configuration. `GITHUB_SHA` is new here, not named by
  ADR-0021: it covers the e2e job's build (`apps/web`'s Playwright suite
  runs against a build made in GitHub Actions, not Netlify).

## Consequences

- No Netlify dashboard build-command configuration is required or
  expected; ADR-0021's Consequences sentence naming that step as
  mandatory no longer holds and is superseded by this decision.
- A GitHub Actions build (the e2e job, or any future CI build of the
  bundle) carries a correct build identity via `GITHUB_SHA` without
  repo-side plumbing, which ADR-0021 did not cover.
- `release.yml`'s smoke job's site check (ADR-0021, unchanged) keeps
  working unmodified: it only reads the resulting meta tag, not how it
  was produced.

ADRs affected: 0021, 0027: the build tag resolves from the platform's
commit variable inside vite.config; 0027 amends 0021's dashboard
precondition.
