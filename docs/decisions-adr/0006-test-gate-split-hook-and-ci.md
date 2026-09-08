# ADR-0006 — The test gate: typecheck and unit on commit, the rest in CI

- **Status:** Proposed (accepted when this PR merges)
- **Date:** 2026-09-08
- **Owner:** Samuel Chan
- **Amends:** ADR-0002 (tests). The three tiers and their tools are
  unchanged; only *where* each tier is required to pass moves.

## Context

ADR-0002 says "`typecheck` + unit + integration must pass before a commit".
With no CI, that rule made the implementing agent the only proof, and the
agent paid for it three times: the red/green loop while coding, the commit
hook on every commit, and a final run of every command with the output
pasted into the PR's Verified section (PR #29 pasted four). The reviewer
then read the paste and sometimes ran the suite again. Integration needs a
running Postgres, so the local run also collided across worktrees sharing
one container (PR #29's Friction line).

A CI workflow now runs on every PR and on push to `main`: frozen install,
typecheck, unit, Prisma migrate and integration against a Postgres 17
service, build, and the accepted-ADR check. A ruleset on `main` requires
that check before merge.

## Decision

- **Before a commit** (the PreToolUse hook, `scripts/pre-commit-check.sh`):
  `typecheck` + unit + the accepted-ADR check. Seconds, no external
  service, catches most breakage where it is cheapest to fix.
- **Before a merge** (`.github/workflows/ci.yml`, required by the `main`
  ruleset): everything above plus integration and build. This is the proof.
- Agents do not run integration locally as a gate. They may run it while
  writing an integration test, as the red/green loop for that test.
- The PR's Verified section lists what CI does not cover (a curl against a
  running service, a manual run, a rehearsal) and what could not be
  checked. It never pastes the output of a command CI runs.
- The reviewer treats a green CI check as the test evidence and a red or
  pending one as a blocking bug (`.claude/skills/review-pr`).

## Consequences

- AGENTS.md rule line updated; the PR template's Verified section says the
  same.
- Merge to `main` requires the `checks` job green and a pull request; the
  owner's direct pushes to `main` are refused too. That is the guardrail
  from the first review, made mechanical.
- Playwright (e2e) is not in CI yet; it joins `ci.yml` when the first e2e
  test lands, and this ADR does not need to change for that.
- Cost moves from agent tokens to CI minutes: one Postgres container and
  roughly two to three minutes per PR event.
