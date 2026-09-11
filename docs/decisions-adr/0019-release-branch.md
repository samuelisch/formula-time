# ADR-0019 — Release only from the release branch

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-11
- **Owner:** Samuel Chan
- **Amends:** ADR-0001 §3 (hosting row: "git-push deploy" names no branch;
  the deploy this repo has built reads `release`, not `main`) and ADR-0008
  (Decision: "The web bundle is built and hosted by Netlify from
  `apps/web` on push to `main`" becomes "on push to `release`"; deploy
  previews and branch deploys are off).

## Context

Owner ruling, 2026-09-11, after weighing a `main`-branch deploy: "we only
release when we push to the release branch. else, we do not release.
right now every push to main triggers a release and it's eating up
credits for netlify and railway." Today both Railway services take their
source from `github("samuelisch/formula-time", { branch: "main" })` in
`.railway/railway.ts`, so every merge redeploys `api` and `ingest`;
Netlify's site builds `main` as its production branch and additionally
builds a deploy preview on every PR push. Both platforms bill per build.

A `main`-branch deploy (deploy on every merge, same as today) was
considered and rejected on 2026-09-11: one build per merge would still
exhaust the plan, and a web build tested against the production api
proves the wrong pair (a PR's web changes against last release's api,
not against each other).

## Decision

- Railway's two services (`api`, `ingest`) read their source from the
  `release` branch, not `main` (`.railway/railway.ts`).
  `.github/workflows/railway-apply.yml` triggers on `push: branches:
  [release]` with the same `.railway/**` path filter; `railway-plan.yml`
  is unchanged, still running on every pull request touching
  `.railway/**`.
- Netlify's build command, publish directory, production branch
  (`release`), deploy previews (off) and branch deploys (off) are site
  settings in the dashboard (Site configuration -> Build & deploy);
  nothing in the repo configures Netlify — an owner-only change.
- `.github/workflows/release.yml` runs on `push: branches: [release]`: a
  `gate` job reuses `ci.yml`'s checks via `workflow_call` (typecheck,
  lint, unit, integration, build, the ADR check — the exact gate a PR
  already passed, not a copy), then a `smoke` job that waits for both
  deploys and confirms each serves traffic. A failed smoke job is red on
  the release commit; it does not roll anything back — the owner decides
  whether to fix forward or roll back.
- `.claude/skills/release/SKILL.md` is the release procedure: from any
  checkout, once `gh run list --branch main --limit 1` shows CI green,
  `git fetch origin && git push origin origin/main:release`. Never push
  anything but `origin/main` to `release`; never commit on `release`.
  Rolling back is pushing the previous main commit to `release` the same
  way.
- ADR-0009's "Loading a past race means running ingest's replay against
  the deployed database" is unchanged; a loaded recording still targets
  whatever database the currently-released `ingest` service points at.

## Consequences

- `main` is the integration branch: every merge is CI-green, and none of
  them deploy anything. A release is a deliberate, separate act.
- The review bot's per-PR Netlify deploy-preview link disappears (previews
  are off), so a PR's `## Verified` describes a local check or a
  rehearse-race rehearsal instead; the CI `e2e` job (Playwright against a
  built bundle) is the built-bundle proof a PR gets.
- The first push to `release` that carries this PR's change is what
  switches the two Railway services' source branch — until then, `main`
  still deploys under the old `.railway/railway.ts`. The owner performs
  that first push, and the Netlify/GitHub/Railway dashboard steps it
  depends on, after this PR merges.
- A release can lag `main` by any number of commits; rolling back is a
  fast-forward to an older commit, not a revert commit on `main`.
- The first apply of `.railway/railway.ts` also adopts each service's live
  `build.buildCommand` and drops the file's `build.builder`, and widens
  `build.watchPatterns` to `packages/**` and the workspace root files: the
  IaC file had never actually been applied since it was written (#20), so
  it had silently drifted from the live environment, and its narrow watch
  pattern (each service's own app directory only) is why a
  `packages/**`-only commit (the #196 migration, the #198 domain rule)
  never triggered a rebuild of either service.

ADRs affected: 0001 (§3 hosting row), 0008 (production branch, deploy
previews).
